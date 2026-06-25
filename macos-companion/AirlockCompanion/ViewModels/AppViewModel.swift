import Foundation
import SwiftUI
import Combine

enum UpdateCheckStatus: Equatable {
    case checking
    case current
    case updateAvailable
    case localBuild
    case failed
}

@MainActor
final class AppViewModel: ObservableObject {
    @Published var pendingRequests: [ApprovalRequest] = []
    @Published var resolvedRequests: [ResolvedRequest] = []
    @Published var activityEvents: [ActivityEvent] = []
    @Published var connectionState: ConnectionState = .disconnected(nil)
    @Published var selectedIndex: Int = 0
    @Published private(set) var appVersion: String
    @Published private(set) var availableUpdateVersion: String?
    @Published private(set) var updateCheckStatus: UpdateCheckStatus = .checking

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
        let storedURL = Self.loadStoredDashboardURL()
        let storedToken = Self.loadStoredGatewayToken(using: tokenStore)
        let sseClient = SSEClient(baseURL: storedURL, bearerToken: storedToken)
        self.sseClient = sseClient
        self.apiClient = AirlockAPIClient(baseURL: storedURL, bearerToken: storedToken)
        self.notificationManager = NotificationManager()
        self.updateChecker = UpdateChecker()
        let bundleVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let displayVersion = Bundle.main.object(forInfoDictionaryKey: "AirlockCompanionDisplayVersion") as? String
        self.appVersion = Self.displayVersion(bundleVersion: bundleVersion, displayVersion: displayVersion)
        self.dashboardURL = storedURL
        self.gatewayToken = storedToken

        sseClient.$connectionState
            .removeDuplicates()
            .sink { [weak self] state in
                self?.connectionState = state
            }
            .store(in: &cancellables)

        notificationManager.onAction = { [weak self] id, action, remember, durationMs in
            guard let self else { return }
            Task { @MainActor in
                if action == "approved" {
                    self.approve(id: id, remember: remember, durationMs: durationMs)
                } else {
                    self.deny(id: id)
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

    func approve(id: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) {
        guard !markExpiredIfNeeded(id: id) else { return }
        let code = seenRequests[id]?.code ?? id
        moveToResolved(id: id, action: "approved")
        notificationManager.removeNotification(id: id)

        let client = apiClient
        Task { [weak self] in
            do {
                try await client.approve(id: id, remember: remember, durationMs: durationMs)
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

    func deny(id: String) {
        guard !markExpiredIfNeeded(id: id) else { return }
        let code = seenRequests[id]?.code ?? id
        moveToResolved(id: id, action: "denied")
        notificationManager.removeNotification(id: id)

        let client = apiClient
        Task { [weak self] in
            do {
                try await client.deny(id: id)
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
        try await DashboardConnection(baseURL: baseURL, bearerToken: bearerToken).validateManagementAPI()
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
        approve(id: pendingRequests[index].id)
        if selectedIndex >= pendingRequests.count - 1 {
            selectedIndex = max(0, pendingRequests.count - 2)
        }
    }

    func denySelectedRequest() {
        guard !pendingRequests.isEmpty else { return }
        let index = min(selectedIndex, pendingRequests.count - 1)
        deny(id: pendingRequests[index].id)
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
            upsertPendingRequest(request, notifyIfNew: true)

        case .resolved(let id, _, let action):
            if action == "timeout" || action == "cancelled" {
                removePendingRequests(withIds: [id])
                return
            }
            moveToResolved(id: id, action: action)
            notificationManager.removeNotification(id: id)

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

    private func upsertPendingRequest(_ request: ApprovalRequest, notifyIfNew: Bool) {
        let wasPending = pendingRequests.contains(where: { $0.id == request.id })
        seenRequests[request.id] = request

        if let index = pendingRequests.firstIndex(where: { $0.id == request.id }) {
            pendingRequests[index] = request
        } else {
            pendingRequests.insert(request, at: 0)
        }

        if notifyIfNew && !wasPending {
            notificationManager.showNotification(for: request, soundEnabled: soundEnabled)
        }
    }

    private func moveToResolved(id: String, action: String) {
        pendingRequests.removeAll { $0.id == id }
        selectedIndex = min(selectedIndex, max(0, pendingRequests.count - 1))
        // Skip if already resolved (optimistic UI already added it).
        guard !resolvedRequests.contains(where: { $0.id == id }) else { return }
        let seen = seenRequests[id]
        let resolved = ResolvedRequest(
            id: id,
            code: seen?.code ?? id,
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

    private func markExpiredIfNeeded(id: String) -> Bool {
        guard let request = pendingRequests.first(where: { $0.id == id }),
              request.isExpired()
        else {
            return false
        }

        moveToResolved(id: id, action: "timeout")
        notificationManager.removeNotification(id: id)
        return true
    }

    private func removePendingRequests(withIds ids: Set<String>) {
        guard !ids.isEmpty else { return }
        removePendingRequests { ids.contains($0.id) }
    }

    private func removePendingRequests(where shouldRemove: (ApprovalRequest) -> Bool) {
        let removedIds = Set(pendingRequests.filter(shouldRemove).map(\.id))
        guard !removedIds.isEmpty else { return }

        pendingRequests.removeAll { removedIds.contains($0.id) }
        for id in removedIds {
            notificationManager.removeNotification(id: id)
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
        let client = apiClient
        do {
            let fetched = try await client.pendingApprovals()
            let snapshot = fetched.filter { !$0.isExpired() }
            let snapshotIds = Set(snapshot.map(\.id))
            let removedIds = Set(pendingRequests.map(\.id)).subtracting(snapshotIds)

            for id in removedIds {
                notificationManager.removeNotification(id: id)
            }

            let existingIds = Set(pendingRequests.map(\.id))
            pendingRequests = snapshot
            for request in snapshot {
                seenRequests[request.id] = request
                if !existingIds.contains(request.id) {
                    notificationManager.showNotification(for: request, soundEnabled: soundEnabled)
                }
            }
            selectedIndex = min(selectedIndex, max(0, pendingRequests.count - 1))
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
            updateCheckStatus = result == nil
                ? (Self.isLocalBuildVersion(appVersion) ? .localBuild : .current)
                : .updateAvailable
        } catch {
            updateCheckStatus = .failed
        }
    }

    nonisolated static func displayVersion(bundleVersion: String, displayVersion: String? = nil) -> String {
        let trimmedDisplayVersion = displayVersion?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedDisplayVersion.isEmpty {
            return trimmedDisplayVersion
        }

        let trimmedBundleVersion = bundleVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedBundleVersion == "0.0.0" || trimmedBundleVersion.isEmpty
            ? "0.0.0 (dev)"
            : trimmedBundleVersion
    }

    nonisolated static func isLocalBuildVersion(_ version: String) -> Bool {
        let normalized = version.lowercased()
        return normalized.contains("dev") || normalized.contains("local")
    }

    private static func loadStoredGatewayToken(using tokenStore: KeychainTokenStore) -> String {
        let keychainToken = (try? tokenStore.load()) ?? ""
        let legacyToken = loadDefaultString(forKey: Constants.UserDefaultsKeys.gatewayToken)

        if !legacyToken.isEmpty {
            if keychainToken.isEmpty {
                try? tokenStore.save(legacyToken)
            }
        }
        removeLegacySecretDefaults()

        return keychainToken.isEmpty ? legacyToken : keychainToken
    }

    private static func loadStoredDashboardURL() -> String {
        let storedURL = loadDefaultString(forKey: Constants.UserDefaultsKeys.dashboardURL)
        guard !storedURL.isEmpty else {
            return Constants.defaultDashboardURL
        }

        UserDefaults.standard.set(storedURL, forKey: Constants.UserDefaultsKeys.dashboardURL)
        return storedURL
    }

    private static func loadDefaultString(forKey key: String) -> String {
        let currentValue = UserDefaults.standard
            .string(forKey: key)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !currentValue.isEmpty {
            return currentValue
        }
        return loadLegacyDefaultString(forKey: key)
    }

    private static func loadLegacyDefaultString(forKey key: String) -> String {
        for suiteName in Constants.LegacyDefaults.suiteNames {
            let value = UserDefaults(suiteName: suiteName)?
                .string(forKey: key)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !value.isEmpty {
                return value
            }
        }
        return ""
    }

    private static func removeLegacySecretDefaults() {
        UserDefaults.standard.removeObject(forKey: Constants.UserDefaultsKeys.gatewayToken)
        for suiteName in Constants.LegacyDefaults.suiteNames {
            UserDefaults(suiteName: suiteName)?
                .removeObject(forKey: Constants.UserDefaultsKeys.gatewayToken)
        }
    }
}
