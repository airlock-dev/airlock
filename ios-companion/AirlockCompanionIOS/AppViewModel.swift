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

        do {
            async let pending = client.pendingApprovals()
            async let history = client.approvalHistory()
            async let activity = client.activityEvents()
            self.pending = try await pending
            self.history = try await history
            self.activityEvents = try await activity
            connectionMessage = "Connected"
            lastError = nil
            await updateAppBadge()
        } catch {
            connectionMessage = "Offline"
            lastError = error.localizedDescription
        }
    }

    private func updateAppBadge() async {
        let badgeCount = activePendingCount
        let activeIds = Set(activePending.map(\.id))
        NotificationManager.shared.removeDeliveredApprovalNotifications(excluding: activeIds)
        if #available(iOS 17.0, *) {
            try? await UNUserNotificationCenter.current().setBadgeCount(badgeCount)
        } else {
            UIApplication.shared.applicationIconBadgeNumber = badgeCount
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
        await updateAppBadge()

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
        durationMs: Int? = nil
    ) async {
        guard let client else { return }
        pending.removeAll { $0.id == approval.id }
        do {
            try await client.decide(
                id: approval.id,
                decision: decision,
                remember: remember,
                durationMs: durationMs,
                reason: decision == .denied ? "Denied from iOS" : nil
            )
            await refreshAsync()
        } catch {
            lastError = error.localizedDescription
            await refreshAsync()
        }
    }
}
