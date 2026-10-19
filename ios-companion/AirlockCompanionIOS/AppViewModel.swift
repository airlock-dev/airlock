import Foundation
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class AppViewModel: ObservableObject {
    @AppStorage("baseURL") var baseURLString = ""
    @AppStorage("adminSecret") var adminSecret = ""
    @AppStorage("deviceToken") var deviceToken = ""
    @AppStorage("deviceId") var deviceId = ""
    @AppStorage("apnsToken") var apnsToken = ""
    @AppStorage("hapticsEnabled") var hapticsEnabled = true
    @AppStorage("lastNotificationActionError") var lastNotificationActionError = ""
    @AppStorage("lastPushRegistrationError") var lastPushRegistrationError = ""

    @Published var pending: [ApprovalRequest] = []
    @Published var history: [ApprovalRequest] = []
    @Published var activityEvents: [ActivityEvent] = []
    @Published var grants: [ApprovalGrant] = []
    @Published var isRefreshing = false
    @Published var connectionMessage = "Not connected"
    @Published var lastError: String?
    @Published var appearance: String {
        didSet {
            UserDefaults.standard.set(appearance, forKey: "appearance")
        }
    }
    @Published var detailDecisionBehavior: String {
        didSet {
            UserDefaults.standard.set(detailDecisionBehavior, forKey: "detailDecisionBehavior")
        }
    }
    @Published var foregroundNotificationBehavior: String {
        didSet {
            UserDefaults.standard.set(foregroundNotificationBehavior, forKey: "foregroundNotificationBehavior")
        }
    }

    private var refreshTask: Task<Void, Never>?

    init() {
        appearance = UserDefaults.standard.string(forKey: "appearance") ?? AppAppearance.system.rawValue
        detailDecisionBehavior = UserDefaults.standard.string(forKey: "detailDecisionBehavior")
            ?? DetailDecisionBehavior.showNext.rawValue
        foregroundNotificationBehavior = UserDefaults.standard.string(forKey: "foregroundNotificationBehavior")
            ?? ForegroundNotificationBehavior.quiet.rawValue
    }

    var isRegistered: Bool {
        !deviceToken.isEmpty
    }

    var preferredColorScheme: ColorScheme? {
        AppAppearance(rawValue: appearance)?.colorScheme
    }

    var decisionBehavior: DetailDecisionBehavior {
        DetailDecisionBehavior(rawValue: detailDecisionBehavior) ?? .showNext
    }

    var foregroundBehavior: ForegroundNotificationBehavior {
        ForegroundNotificationBehavior(rawValue: foregroundNotificationBehavior) ?? .quiet
    }

    var activePending: [ApprovalRequest] {
        let now = Date()
        return pending.filter { !$0.isExpired(at: now) }
    }

    var activePendingCount: Int {
        activePending.count
    }

    /// Pending approvals in queue order, with members of a shared notification batch kept together.
    var pendingGroups: [PendingGroup] {
        let active = activePending
        var batchMembers: [String: [ApprovalRequest]] = [:]
        for approval in active {
            if let batchId = approval.batchId {
                batchMembers[batchId, default: []].append(approval)
            }
        }

        var seenBatches = Set<String>()
        var groups: [PendingGroup] = []
        for approval in active {
            if let batchId = approval.batchId, let members = batchMembers[batchId], members.count > 1 {
                guard seenBatches.insert(batchId).inserted else { continue }
                groups.append(.batch(ApprovalBatch(id: batchId, code: approval.batchCode, approvals: members)))
            } else {
                groups.append(.single(approval))
            }
        }
        return groups
    }

    var activeGrants: [ApprovalGrant] {
        let now = Date()
        return grants.filter { !$0.isExpired(at: now) }
    }

    var client: AirlockAPIClient? {
        guard let baseURL = secureBaseURL else { return nil }
        return AirlockAPIClient(baseURL: baseURL, bearerToken: deviceToken.isEmpty ? adminSecret : deviceToken)
    }

    private var secureBaseURL: URL? {
        guard let baseURL = URL(string: baseURLString), baseURL.scheme == "https" else { return nil }
        return baseURL
    }

    func start() {
        NotificationManager.shared.requestAuthorization()
        UIApplication.shared.registerForRemoteNotifications()
        refresh()

        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                await self?.refreshAsync()
            }
        }
    }

    func stop() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    func refresh() {
        Task { await refreshAsync() }
    }

    func refreshNow() async {
        await refreshAsync()
    }

    func registerCurrentDevice() {
        Task { await registerCurrentDeviceAsync() }
    }

    func forgetCurrentDevice() {
        Task { await forgetCurrentDeviceAsync() }
    }

    func clearPushDiagnostics() {
        lastNotificationActionError = ""
        lastPushRegistrationError = ""
    }

    func sendLocalTestNotification() {
        NotificationManager.shared.sendLocalDiagnosticNotification()
    }

    func approve(_ approval: ApprovalRequest, remember: RememberMode? = nil, durationMs: Int? = nil) {
        Task {
            await decide(approval, decision: .approved, remember: remember, durationMs: durationMs)
        }
    }

    func approve(_ approval: ApprovalRequest, grantOption: GrantOption, duration: GrantDuration) {
        Task {
            await decide(
                approval,
                decision: .approved,
                grant: GrantRequest(option: grantOption, durationMs: duration.rawValue)
            )
        }
    }

    func approveAll(in batch: ApprovalBatch) {
        Task { await decideMany(batch.approvableIds, decision: .approved) }
    }

    func denyAll(in batch: ApprovalBatch) {
        Task { await decideMany(batch.approvals.map(\.id), decision: .denied) }
    }

    func revoke(_ grant: ApprovalGrant) {
        Task { await revokeAsync(grant) }
    }

    func refreshGrants() async {
        guard let client else { return }
        do {
            grants = try await client.grants()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func deny(_ approval: ApprovalRequest) {
        Task {
            await decide(approval, decision: .denied)
        }
    }

    private func refreshAsync() async {
        guard let client else {
            connectionMessage = "Invalid URL"
            lastError = "Airlock URL must use HTTPS."
            return
        }

        isRefreshing = true
        defer { isRefreshing = false }

        let startedAt = Date()
        do {
            async let pending = client.pendingApprovals()
            async let history = client.approvalHistory()
            async let activity = client.activityEvents()
            self.pending = try await pending
            await NotificationManager.shared.reconcileApprovalNotifications(with: self.pending, fetchedAfter: startedAt)
            self.history = try await history
            self.activityEvents = try await activity
            // Older gateways have no grants endpoint; keep the queue usable without it.
            if let grants = try? await client.grants() {
                self.grants = grants
            }
            connectionMessage = "Connected"
            lastError = nil
        } catch {
            connectionMessage = "Offline"
            lastError = error.localizedDescription
        }
    }

    private func registerCurrentDeviceAsync() async {
        guard let baseURL = secureBaseURL, !adminSecret.isEmpty else {
            lastError = "Enter the Airlock URL and admin secret first."
            return
        }
        guard !apnsToken.isEmpty else {
            UIApplication.shared.registerForRemoteNotifications()
            lastError = "Waiting for iOS to return a push token."
            return
        }

        do {
            let client = AirlockAPIClient(baseURL: baseURL, bearerToken: adminSecret)
            let response = try await client.registerDevice(
                name: UIDevice.current.name,
                pushToken: apnsToken,
                adminSecret: adminSecret
            )
            deviceId = response.id
            deviceToken = response.token
            lastPushRegistrationError = ""
            lastNotificationActionError = ""
            lastError = nil
            connectionMessage = "Registered"
            await refreshAsync()
        } catch {
            lastError = error.localizedDescription
            connectionMessage = "Registration failed"
        }
    }

    private func forgetCurrentDeviceAsync() async {
        let revokeClient = client
        let hadServerDevice = !deviceToken.isEmpty
        var revokeError: Error?

        if hadServerDevice {
            do {
                try await revokeClient?.unregisterCurrentDevice()
            } catch {
                revokeError = error
            }
        }

        deviceId = ""
        deviceToken = ""
        lastNotificationActionError = ""
        if #available(iOS 17.0, *) {
            try? await UNUserNotificationCenter.current().setBadgeCount(activePendingCount)
        } else {
            UIApplication.shared.applicationIconBadgeNumber = activePendingCount
        }

        if let revokeError {
            lastError = "Forgot locally. Server revoke failed: \(revokeError.localizedDescription)"
            connectionMessage = "Needs registration"
        } else {
            lastError = nil
            connectionMessage = "Not registered"
        }
    }

    private func decide(
        _ approval: ApprovalRequest,
        decision: ApprovalDecision,
        remember: RememberMode? = nil,
        durationMs: Int? = nil,
        grant: GrantRequest? = nil
    ) async {
        guard let client else { return }
        pending.removeAll { $0.id == approval.id }
        do {
            let response = try await client.decide(
                id: approval.id,
                decision: decision,
                remember: remember,
                durationMs: durationMs,
                reason: decision == .denied ? "Denied from iOS" : nil,
                grant: grant
            )
            // A new grant can auto-approve other pending requests it now covers.
            let resolved = Set(response.approved ?? [])
            pending.removeAll { resolved.contains($0.id) }
            await refreshAsync()
        } catch {
            lastError = error.localizedDescription
            await refreshAsync()
        }
    }

    private func decideMany(_ ids: [String], decision: ApprovalDecision) async {
        guard let client, !ids.isEmpty else { return }
        let requested = Set(ids)
        pending.removeAll { requested.contains($0.id) }
        do {
            try await client.decideMany(
                ids: ids,
                decision: decision,
                reason: decision == .denied ? "Denied from iOS" : nil
            )
            await refreshAsync()
        } catch {
            lastError = error.localizedDescription
            await refreshAsync()
        }
    }

    private func revokeAsync(_ grant: ApprovalGrant) async {
        guard let client else { return }
        grants.removeAll { $0.id == grant.id }
        do {
            try await client.revokeGrant(id: grant.id)
        } catch {
            lastError = error.localizedDescription
        }
        await refreshGrants()
    }
}

enum PendingGroup: Identifiable {
    case single(ApprovalRequest)
    case batch(ApprovalBatch)

    var id: String {
        switch self {
        case .single(let approval):
            return "approval-\(approval.id)"
        case .batch(let batch):
            return "batch-\(batch.id)"
        }
    }
}
