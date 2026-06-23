import Foundation
import SwiftUI
import Combine

@MainActor
final class AppViewModel: ObservableObject {
    @Published var pendingRequests: [ApprovalRequest] = []
    @Published var resolvedRequests: [ResolvedRequest] = []
    @Published var activityEvents: [ActivityEvent] = []
    @Published var connectionState: ConnectionState = .disconnected(nil)
    @Published var selectedIndex: Int = 0
    @Published private(set) var appVersion: String
    @Published private(set) var availableUpdateVersion: String?

    @AppStorage(Constants.UserDefaultsKeys.dashboardURL)
    var dashboardURL: String = Constants.defaultDashboardURL

    @Published private(set) var gatewayToken: String = ""

    @AppStorage(Constants.UserDefaultsKeys.soundEnabled)
    var soundEnabled: Bool = true

    @AppStorage(Constants.UserDefaultsKeys.approveShortcutKey)
    var approveShortcutKey: String = "S"

    @AppStorage(Constants.UserDefaultsKeys.denyShortcutKey)
    var denyShortcutKey: String = "D"

    @AppStorage(Constants.UserDefaultsKeys.autoExpandSelectedRequest)
    var autoExpandSelectedRequest: Bool = false

    @AppStorage(Constants.UserDefaultsKeys.displayDensity)
    var displayDensity: String = DisplayDensity.compact.rawValue

    @AppStorage(Constants.UserDefaultsKeys.lastNotificationActionError)
    var lastNotificationActionError: String = ""

    @AppStorage(Constants.UserDefaultsKeys.lastNotificationDeliveryError)
    var lastNotificationDeliveryError: String = ""

    var density: DisplayDensity {
        DisplayDensity(rawValue: displayDensity) ?? .compact
    }

    let sseClient: SSEClient
    let notificationManager: NotificationManager
    private var apiClient: AirlockAPIClient
    private let updateChecker: UpdateChecker
    private let tokenStore = KeychainTokenStore()
    var onSettingsChanged: (() -> Void)?
    private var sseTask: Task<Void, Never>?
    private var updateCheckTask: Task<Void, Never>?
    private var pendingMaintenanceTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    /// Lookup of all requests we've ever seen, so history always has metadata
    private var seenRequests: [String: ApprovalRequest] = [:]

    var pendingCount: Int { pendingRequests.count }

    init() {
        let storedURL = UserDefaults.standard.string(forKey: Constants.UserDefaultsKeys.dashboardURL)
            ?? Constants.defaultDashboardURL
        let storedToken = Self.loadStoredGatewayToken(using: tokenStore)
        let sseClient = SSEClient(baseURL: storedURL, bearerToken: storedToken)
        self.sseClient = sseClient
        self.apiClient = AirlockAPIClient(baseURL: storedURL, bearerToken: storedToken)
        self.notificationManager = NotificationManager()
        self.updateChecker = UpdateChecker()
        let bundleVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        self.appVersion = bundleVersion == "0.0.0" ? "0.0.0 (dev)" : bundleVersion

        sseClient.$connectionState
            .removeDuplicates()
            .sink { [weak self] state in
                self?.connectionState = state
            }
            .store(in: &cancellables)

        notificationManager.onAction = { [weak self] code, action, remember, durationMs in
            guard let self else { return }
            Task { @MainActor in
                if action == "approved" {
                    self.approve(code: code, remember: remember, durationMs: durationMs)
                } else {
                    self.deny(code: code)
                }
            }
        }

        notificationManager.onError = { [weak self] message in
            self?.lastNotificationDeliveryError = message
        }
    }

    func start() {
        notificationManager.requestAuthorization()
        startUpdateChecks()
        startPendingMaintenance()
        connectSSE()
    }

    func stop() {
        sseTask?.cancel()
        sseTask = nil
        updateCheckTask?.cancel()
        updateCheckTask = nil
        pendingMaintenanceTask?.cancel()
        pendingMaintenanceTask = nil
        sseClient.disconnect()
    }

    func reconnect() {
        connectSSE()
    }

    func approve(code: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) {
        guard !markExpiredIfNeeded(code: code) else { return }
        moveToResolved(code: code, action: "approved")
        notificationManager.removeNotification(code: code)

        let client = apiClient
        Task { [weak self] in
            do {
                try await client.approve(code: code, remember: remember, durationMs: durationMs)
                await MainActor.run {
                    self?.lastNotificationActionError = ""
                }
            } catch {
                await MainActor.run {
                    self?.lastNotificationActionError = "Approve \(code) failed: \(error.localizedDescription)"
                }
            }
        }
    }

    func deny(code: String) {
        guard !markExpiredIfNeeded(code: code) else { return }
        moveToResolved(code: code, action: "denied")
        notificationManager.removeNotification(code: code)

        let client = apiClient
        Task { [weak self] in
            do {
                try await client.deny(code: code)
                await MainActor.run {
                    self?.lastNotificationActionError = ""
                }
            } catch {
                await MainActor.run {
                    self?.lastNotificationActionError = "Deny \(code) failed: \(error.localizedDescription)"
                }
            }
        }
    }

    func clearNotificationDiagnostics() {
        lastNotificationActionError = ""
        lastNotificationDeliveryError = ""
    }

    func updateSettings(reconnect: Bool = false) {
        onSettingsChanged?()
        if reconnect {
            sseClient.updateConnection(baseURL: dashboardURL, bearerToken: gatewayToken)
            apiClient = AirlockAPIClient(baseURL: dashboardURL, bearerToken: gatewayToken)
            connectSSE()
        }
    }

    func testConnection(baseURL: String, bearerToken: String) async throws {
        try await DashboardConnection(baseURL: baseURL, bearerToken: bearerToken).validateHealth()
    }

    func saveConnectionSettings(baseURL: String, bearerToken: String) throws {
        let trimmedToken = bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        try tokenStore.save(trimmedToken)

        dashboardURL = baseURL
        gatewayToken = trimmedToken
        updateSettings(reconnect: true)
    }

    func approveSelectedRequest() {
        guard !pendingRequests.isEmpty else { return }
        let index = min(selectedIndex, pendingRequests.count - 1)
        approve(code: pendingRequests[index].code)
        if selectedIndex >= pendingRequests.count - 1 {
            selectedIndex = max(0, pendingRequests.count - 2)
        }
    }

    func denySelectedRequest() {
        guard !pendingRequests.isEmpty else { return }
        let index = min(selectedIndex, pendingRequests.count - 1)
        deny(code: pendingRequests[index].code)
        if selectedIndex >= pendingRequests.count - 1 {
            selectedIndex = max(0, pendingRequests.count - 2)
        }
    }

    // MARK: - Private

    private func connectSSE() {
        sseTask?.cancel()
        sseClient.updateConnection(baseURL: dashboardURL, bearerToken: gatewayToken)

        let stream = sseClient.connect()

        sseTask = Task { [weak self] in
            for await message in stream {
                guard let self, !Task.isCancelled else { break }
                self.handleSSEMessage(message)
            }
        }
    }

    private func handleSSEMessage(_ message: SSEMessage) {
        switch message {
        case .newRequest(let request):
            pruneExpiredRequests()
            guard request.timeoutMs == 0 || request.deadline > Date() else { return }
            seenRequests[request.code] = request
            // Avoid duplicates.
            if !pendingRequests.contains(where: { $0.code == request.code }) {
                pendingRequests.insert(request, at: 0)
            }
            notificationManager.showNotification(for: request, soundEnabled: soundEnabled)

        case .resolved(let code, let action):
            if action == "timeout" || action == "cancelled" {
                removePendingRequests(withCodes: [code])
                return
            }
            moveToResolved(code: code, action: action)
            notificationManager.removeNotification(code: code)

        case .activity(let event):
            upsertActivityEvent(event)
            notificationManager.showNotification(for: event, soundEnabled: soundEnabled)
        }
    }

    private func upsertActivityEvent(_ event: ActivityEvent) {
        activityEvents.removeAll { $0.id == event.id }
        activityEvents.insert(event, at: 0)
        if activityEvents.count > Constants.maxResolvedRequests {
            activityEvents = Array(activityEvents.prefix(Constants.maxResolvedRequests))
        }
    }

    private func moveToResolved(code: String, action: String) {
        pendingRequests.removeAll { $0.code == code }
        selectedIndex = min(selectedIndex, max(0, pendingRequests.count - 1))
        // Skip if already resolved (optimistic UI already added it).
        guard !resolvedRequests.contains(where: { $0.code == code }) else { return }
        let seen = seenRequests[code]
        let resolved = ResolvedRequest(
            code: code,
            action: action,
            tool: seen?.tool ?? "",
            agentId: seen?.agentId ?? "",
            title: seen?.displayTitle ?? "",
            detail: resolvedDetail(for: seen),
            argsDisplay: seen?.argsDisplayString ?? ""
        )
        resolvedRequests.insert(resolved, at: 0)
        if resolvedRequests.count > Constants.maxResolvedRequests {
            resolvedRequests = Array(resolvedRequests.prefix(Constants.maxResolvedRequests))
        }
    }

    private func resolvedDetail(for request: ApprovalRequest?) -> String {
        guard let request else { return "" }
        if let reason = request.requestReason { return reason }
        if request.isUserQuestion, let context = request.questionContext { return context }
        if let note = request.requestNote { return note }
        if !request.isUserQuestion, !request.argsDisplayString.isEmpty { return request.argsDisplayString }
        return request.displaySubtitle
    }

    private func markExpiredIfNeeded(code: String) -> Bool {
        guard let request = pendingRequests.first(where: { $0.code == code }),
              request.isExpired()
        else {
            return false
        }

        moveToResolved(code: code, action: "timeout")
        notificationManager.removeNotification(code: code)
        return true
    }

    private func removePendingRequests(withCodes codes: Set<String>) {
        guard !codes.isEmpty else { return }
        removePendingRequests { codes.contains($0.code) }
    }

    private func removePendingRequests(where shouldRemove: (ApprovalRequest) -> Bool) {
        let removedCodes = Set(pendingRequests.filter(shouldRemove).map(\.code))
        guard !removedCodes.isEmpty else { return }

        pendingRequests.removeAll { removedCodes.contains($0.code) }
        for code in removedCodes {
            notificationManager.removeNotification(code: code)
        }
        if selectedIndex >= pendingRequests.count {
            selectedIndex = max(0, pendingRequests.count - 1)
        }
    }

    private func pruneExpiredPendingRequests() {
        pruneExpiredRequests()
    }

    private func pruneExpiredRequests() {
        removePendingRequests { $0.isExpired() }
    }

    private func reconcilePendingRequests() async {
        guard !pendingRequests.isEmpty else { return }

        let client = apiClient
        do {
            let pendingCodes = try await client.pendingApprovalCodes()
            removePendingRequests { !pendingCodes.contains($0.code) }
        } catch {
        }
    }

    private func startPendingMaintenance() {
        pendingMaintenanceTask?.cancel()
        pendingMaintenanceTask = Task { [weak self] in
            guard let self else { return }
            var nextReconcile = Date()

            while !Task.isCancelled {
                self.pruneExpiredPendingRequests()

                if Date() >= nextReconcile {
                    await self.reconcilePendingRequests()
                    nextReconcile = Date().addingTimeInterval(Constants.PendingMaintenance.reconcileInterval)
                }

                try? await Task.sleep(for: .seconds(Constants.PendingMaintenance.pruneInterval))
            }
        }
    }

    private func startUpdateChecks() {
        updateCheckTask?.cancel()
        updateCheckTask = Task { [weak self] in
            guard let self else { return }

            await self.checkForUpdates()

            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Constants.Updates.checkInterval))
                guard !Task.isCancelled else { break }
                await self.checkForUpdates()
            }
        }
    }

    private func checkForUpdates() async {
        do {
            let result = try await updateChecker.checkForUpdate(currentVersion: appVersion)
            availableUpdateVersion = result?.latestVersion
        } catch {
        }
    }

    private static func loadStoredGatewayToken(using tokenStore: KeychainTokenStore) -> String {
        let keychainToken = (try? tokenStore.load()) ?? ""
        let legacyToken = UserDefaults.standard
            .string(forKey: Constants.UserDefaultsKeys.gatewayToken)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if !legacyToken.isEmpty {
            if keychainToken.isEmpty {
                try? tokenStore.save(legacyToken)
            }
            UserDefaults.standard.removeObject(forKey: Constants.UserDefaultsKeys.gatewayToken)
        }

        return keychainToken.isEmpty ? legacyToken : keychainToken
    }
}
