import Foundation
import SwiftUI
import Combine

@MainActor
final class AppViewModel: ObservableObject {
    @Published var pendingRequests: [ApprovalRequest] = []
    @Published var resolvedRequests: [ResolvedRequest] = []
    @Published var connectionState: ConnectionState = .disconnected(nil)
    @Published var selectedIndex: Int = 0
    @Published private(set) var appVersion: String
    @Published private(set) var availableUpdateVersion: String?

    @AppStorage(Constants.UserDefaultsKeys.dashboardURL)
    var dashboardURL: String = Constants.defaultDashboardURL

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
    var onSettingsChanged: (() -> Void)?
    private var sseTask: Task<Void, Never>?
    private var expirationTask: Task<Void, Never>?
    private var updateCheckTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    /// Lookup of all requests we've ever seen, so history always has metadata
    private var seenRequests: [String: ApprovalRequest] = [:]

    var pendingCount: Int { pendingRequests.count }

    init() {
        let sseClient = SSEClient()
        self.sseClient = sseClient
        let storedURL = UserDefaults.standard.string(forKey: Constants.UserDefaultsKeys.dashboardURL)
            ?? Constants.defaultDashboardURL
        self.apiClient = AirlockAPIClient(baseURL: storedURL)
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
        startExpirationChecks()
        connectSSE()
    }

    func stop() {
        sseTask?.cancel()
        sseTask = nil
        updateCheckTask?.cancel()
        updateCheckTask = nil
        expirationTask?.cancel()
        expirationTask = nil
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

    func updateSettings() {
        sseClient.updateBaseURL(dashboardURL)
        apiClient = AirlockAPIClient(baseURL: dashboardURL)
        onSettingsChanged?()
        connectSSE()
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
        sseClient.updateBaseURL(dashboardURL)

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
            seenRequests[request.code] = request
            // Avoid duplicates.
            if !pendingRequests.contains(where: { $0.code == request.code }) {
                pendingRequests.insert(request, at: 0)
            }
            notificationManager.showNotification(for: request, soundEnabled: soundEnabled)

        case .resolved(let code, let action):
            moveToResolved(code: code, action: action)
            notificationManager.removeNotification(code: code)
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
            argsDisplay: seen?.argsDisplayString ?? ""
        )
        resolvedRequests.insert(resolved, at: 0)
        if resolvedRequests.count > Constants.maxResolvedRequests {
            resolvedRequests = Array(resolvedRequests.prefix(Constants.maxResolvedRequests))
        }
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

    private func pruneExpiredRequests() {
        let expiredRequests = pendingRequests.filter { $0.isExpired() }
        guard !expiredRequests.isEmpty else { return }

        for request in expiredRequests {
            moveToResolved(code: request.code, action: "timeout")
            notificationManager.removeNotification(code: request.code)
        }
    }

    private func startExpirationChecks() {
        expirationTask?.cancel()
        expirationTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.pruneExpiredRequests()
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
}
