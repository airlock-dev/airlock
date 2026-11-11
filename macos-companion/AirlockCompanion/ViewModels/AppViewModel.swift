import Foundation
import SwiftUI
import Combine

/// Decides which activity events become system notifications. The approval stream replays recent
/// activity on every (re)connect, so an event must be new to this app run and not already shown.
struct ActivityNotificationGate {
    /// Events created before the app started were never this run's to announce.
    let cutoff: Date
    /// The stream replays at most the server's recent buffer, so remembering that many ids suffices.
    var capacity = 200
    private var notifiedIds: [String] = []

    init(cutoff: Date = Date()) {
        self.cutoff = cutoff
    }

    mutating func shouldNotify(_ event: ActivityEvent) -> Bool {
        guard event.kind == "notification",
              event.createdDate > cutoff,
              !notifiedIds.contains(event.id)
        else { return false }
        notifiedIds.append(event.id)
        if notifiedIds.count > capacity {
            notifiedIds.removeFirst(notifiedIds.count - capacity)
        }
        return true
    }
}

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
    @Published private(set) var grants: [ApprovalGrant] = []
    @Published var connectionState: ConnectionState = .disconnected(nil)
    /// The selection follows a request, not a row: the list can reorder or shrink under it.
    @Published private(set) var selectedRequestId: String?
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
    private var activityNotifications = ActivityNotificationGate()

    var pendingCount: Int { pendingRequests.count }

    /// Row of the selected request; 0 when nothing (or a request no longer pending) is selected.
    var selectedIndex: Int {
        get {
            selectedRequestId.flatMap { id in pendingRequests.firstIndex { $0.id == id } } ?? 0
        }
        set {
            selectedRequestId = pendingRequests.indices.contains(newValue)
                ? pendingRequests[newValue].id
                : pendingRequests.first?.id
        }
    }

    /// Visible requests that share a notification batch (or, without one, an agent), in list order.
    /// Only groups of two or more get "Approve all" / "Deny all" controls.
    var approvalGroups: [ApprovalGroup] {
        ApprovalGroup.groups(from: pendingRequests)
    }

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

    func approvalPreview(id: String) async throws -> ApprovalPreview {
        try await apiClient.approvalPreview(id: id)
    }

    func approve(id: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil, grant: GrantSpec? = nil) {
        guard !markExpiredIfNeeded(id: id) else { return }
        let code = seenRequests[id]?.code ?? id
        moveToResolved(id: id, action: "approved")
        notificationManager.removeNotification(id: id)

        let client = apiClient
        let createsGrant = grant != nil || remember == .temporary
        Task { [weak self] in
            do {
                let outcome = try await client.approve(id: id, remember: remember, durationMs: durationMs, grant: grant)
                await MainActor.run {
                    guard let self else { return }
                    self.lastNotificationActionError = ""
                    // A new grant can auto-approve other pending requests; SSE will confirm too.
                    for otherId in outcome.approved where otherId != id {
                        self.moveToResolved(id: otherId, action: "approved")
                        self.notificationManager.removeNotification(id: otherId)
                    }
                    if createsGrant { self.refreshGrants() }
                }
            } catch {
                await self?.rollBackFailedDecision(
                    ids: [id],
                    message: "Approve \(code) failed: \(error.localizedDescription)"
                )
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
                await self?.rollBackFailedDecision(
                    ids: [id],
                    message: "Deny \(code) failed: \(error.localizedDescription)"
                )
            }
        }
    }

    /// Approve an explicit set of visible requests. Escalated requests and questions are never
    /// included; they must be decided individually.
    func approveAll(ids: [String]) {
        let eligible = ids.filter { id in
            guard let request = pendingRequests.first(where: { $0.id == id }) else { return false }
            return request.canBulkApprove && !request.isExpired()
        }
        guard !eligible.isEmpty else { return }
        decideMany(ids: eligible, decision: "approved")
    }

    func denyAll(ids: [String]) {
        let eligible = ids.filter { id in pendingRequests.contains(where: { $0.id == id && !$0.isExpired() }) }
        guard !eligible.isEmpty else { return }
        decideMany(ids: eligible, decision: "denied")
    }

    func refreshGrants() {
        let client = apiClient
        Task { [weak self] in
            guard let fetched = try? await client.grants() else { return }
            await MainActor.run {
                self?.grants = fetched.filter { !$0.isExpired() }
            }
        }
    }

    func revokeGrant(id: String) {
        grants.removeAll { $0.id == id }
        let client = apiClient
        Task { [weak self] in
            do {
                try await client.revokeGrant(id: id)
            } catch {
                await MainActor.run {
                    self?.lastNotificationActionError = "Revoke grant failed: \(error.localizedDescription)"
                }
            }
            await MainActor.run { self?.refreshGrants() }
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

    // Removing the request moves the selection to the row that takes its place.
    func approveSelectedRequest() {
        guard !pendingRequests.isEmpty else { return }
        approve(id: pendingRequests[selectedIndex].id)
    }

    func denySelectedRequest() {
        guard !pendingRequests.isEmpty else { return }
        deny(id: pendingRequests[selectedIndex].id)
    }

    // MARK: - Private

    private func decideMany(ids: [String], decision: String) {
        for id in ids {
            moveToResolved(id: id, action: decision)
            notificationManager.removeNotification(id: id)
        }

        let client = apiClient
        let reason = decision == "denied" ? AirlockAPIClient.denyReason : nil
        Task { [weak self] in
            do {
                let outcome = try await client.decide(ids: ids, decision: decision, reason: reason)
                guard let self else { return }
                self.lastNotificationActionError = ""
                // Anything the server skipped may still be pending; re-sync now rather than on the next tick.
                if !outcome.skipped.isEmpty {
                    self.resolvedRequests.removeAll { outcome.skipped.contains($0.id) }
                    await self.reconcilePendingRequests()
                }
            } catch {
                let verb = decision == "approved" ? "Approve" : "Deny"
                await self?.rollBackFailedDecision(
                    ids: ids,
                    message: "\(verb) all (\(ids.count)) failed: \(error.localizedDescription)"
                )
            }
        }
    }

    /// A decision the server refused: put back whatever is still pending (without notifying it a
    /// second time) and drop its optimistic "approved"/"denied" row from Recent.
    private func rollBackFailedDecision(ids: [String], message: String) async {
        lastNotificationActionError = message
        await reconcilePendingRequests()
        let stillPending = Set(pendingRequests.map(\.id)).intersection(ids)
        resolvedRequests.removeAll { stillPending.contains($0.id) }
    }

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
        case .newRequest(let incoming):
            pruneExpiredRequests()
            let request = incoming.keepingTimestamps(of: seenRequests[incoming.id])
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
            if activityNotifications.shouldNotify(event) {
                notificationManager.showNotification(for: event, soundEnabled: soundEnabled)
            }
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

        updatePendingRequests { pending in
            if let index = pending.firstIndex(where: { $0.id == request.id }) {
                pending[index] = request
            } else {
                pending.append(request)
            }
        }

        if notifyIfNew && !wasPending {
            notificationManager.showNotification(for: request, soundEnabled: soundEnabled)
        }
    }

    private func moveToResolved(id: String, action: String) {
        updatePendingRequests { $0.removeAll { $0.id == id } }
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

        updatePendingRequests { $0.removeAll { removedIds.contains($0.id) } }
        for id in removedIds {
            notificationManager.removeNotification(id: id)
        }
    }

    /// Every change to the pending list goes through here so the order stays stable (newest first)
    /// and a selected request that disappears hands the selection to the row that replaces it.
    private func updatePendingRequests(_ change: (inout [ApprovalRequest]) -> Void) {
        let selectedRow = selectedRequestId.flatMap { id in pendingRequests.firstIndex { $0.id == id } }
        var updated = pendingRequests
        change(&updated)
        updated = Self.pendingOrder(updated)
        if updated != pendingRequests {
            pendingRequests = updated
        }
        let selection = Self.selection(keeping: selectedRequestId, previousRow: selectedRow, in: updated)
        if selection != selectedRequestId {
            selectedRequestId = selection
        }
    }

    /// The selected id while it is still listed; otherwise the request now in its old row.
    nonisolated static func selection(
        keeping selectedId: String?,
        previousRow: Int?,
        in requests: [ApprovalRequest]
    ) -> String? {
        guard let selectedId else { return nil }
        if requests.contains(where: { $0.id == selectedId }) { return selectedId }
        guard !requests.isEmpty else { return nil }
        return requests[min(previousRow ?? 0, requests.count - 1)].id
    }

    /// Newest first. Ties keep their current relative order.
    nonisolated static func pendingOrder(_ requests: [ApprovalRequest]) -> [ApprovalRequest] {
        requests.enumerated()
            .sorted { lhs, rhs in
                lhs.element.receivedAt != rhs.element.receivedAt
                    ? lhs.element.receivedAt > rhs.element.receivedAt
                    : lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    private func pruneExpiredRequests() {
        removePendingRequests { $0.isExpired() }
    }

    private func reconcilePendingRequests() async {
        let client = apiClient
        do {
            let fetched = try await client.pendingApprovals()
            let snapshot = fetched
                .map { $0.keepingTimestamps(of: seenRequests[$0.id]) }
                .filter { !$0.isExpired() }
            let snapshotIds = Set(snapshot.map(\.id))
            let removedIds = Set(pendingRequests.map(\.id)).subtracting(snapshotIds)

            for id in removedIds {
                notificationManager.removeNotification(id: id)
            }

            updatePendingRequests { $0 = snapshot }
            for request in snapshot {
                // Only announce requests this app has never seen; one put back after a failed
                // decision was already announced.
                let isNew = seenRequests[request.id] == nil
                seenRequests[request.id] = request
                if isNew {
                    notificationManager.showNotification(for: request, soundEnabled: soundEnabled)
                }
            }
        } catch {
        }
    }

    private func startPendingMaintenance() {
        pendingMaintenanceTask?.cancel()
        pendingMaintenanceTask = Task { [weak self] in
            guard let self else { return }
            var nextReconcile = Date()

            while !Task.isCancelled {
                self.pruneExpiredRequests()

                if Date() >= nextReconcile {
                    await self.reconcilePendingRequests()
                    self.refreshGrants()
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
        #if DEBUG
        // Dev builds pointed at a test gateway must never read (or prompt for) the installed app's
        // Keychain item, which shares this service name.
        if let override = ProcessInfo.processInfo.environment["AIRLOCK_COMPANION_TOKEN"] {
            return override
        }
        #endif
        let keychainToken = (try? tokenStore.load()) ?? ""
        let legacyToken = loadDefaultString(forKey: Constants.UserDefaultsKeys.gatewayToken)

        if !keychainToken.isEmpty {
            removeLegacySecretDefaults()
            return keychainToken
        }

        if !legacyToken.isEmpty {
            do {
                try tokenStore.save(legacyToken)
                removeLegacySecretDefaults()
            } catch {
                return legacyToken
            }
        }

        return legacyToken
    }

    private static func loadStoredDashboardURL() -> String {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["AIRLOCK_COMPANION_URL"] {
            return override
        }
        #endif
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
