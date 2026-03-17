import Foundation
import SwiftUI

@MainActor
final class AppViewModel: ObservableObject {
    @Published var pendingRequests: [ApprovalRequest] = []
    @Published var resolvedRequests: [ResolvedRequest] = []
    @Published var connectionState: ConnectionState = .disconnected(nil)
    @Published var currentTime: Date = Date()
    @Published var selectedIndex: Int = 0

    @AppStorage(Constants.UserDefaultsKeys.dashboardURL)
    var dashboardURL: String = Constants.defaultDashboardURL

    @AppStorage(Constants.UserDefaultsKeys.soundEnabled)
    var soundEnabled: Bool = true

    let sseClient: SSEClient
    let notificationManager: NotificationManager
    private var apiClient: AirlockAPIClient
    private var sseTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?
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

        notificationManager.onAction = { [weak self] code, action in
            guard let self else { return }
            Task { @MainActor in
                if action == "approved" {
                    self.approve(code: code)
                } else {
                    self.deny(code: code)
                }
            }
        }
    }

    func start() {
        notificationManager.requestAuthorization()
        startTimer()
        connectSSE()
    }

    func stop() {
        sseTask?.cancel()
        sseTask = nil
        timerTask?.cancel()
        timerTask = nil
        sseClient.disconnect()
    }

    func reconnect() {
        connectSSE()
    }

    func approve(code: String) {
        moveToResolved(code: code, action: "approved")
        notificationManager.removeNotification(code: code)

        let client = apiClient
        Task {
            try? await client.approve(code: code)
        }
    }

    func deny(code: String) {
        moveToResolved(code: code, action: "denied")
        notificationManager.removeNotification(code: code)

        let client = apiClient
        Task {
            try? await client.deny(code: code)
        }
    }

    func updateSettings() {
        sseClient.updateBaseURL(dashboardURL)
        apiClient = AirlockAPIClient(baseURL: dashboardURL)
        connectSSE()
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

        // Observe connection state
        Task { [weak self] in
            guard let self else { return }
            // Poll connection state from SSEClient
            while !Task.isCancelled {
                self.connectionState = self.sseClient.connectionState
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    private func handleSSEMessage(_ message: SSEMessage) {
        switch message {
        case .newRequest(let request):
            seenRequests[request.code] = request
            withAnimation(.spring) {
                // Avoid duplicates
                if !self.pendingRequests.contains(where: { $0.code == request.code }) {
                    self.pendingRequests.insert(request, at: 0)
                }
            }
            notificationManager.showNotification(for: request, soundEnabled: soundEnabled)

        case .resolved(let code, let action):
            moveToResolved(code: code, action: action)
            notificationManager.removeNotification(code: code)
        }
    }

    private func moveToResolved(code: String, action: String) {
        withAnimation(.spring) {
            self.pendingRequests.removeAll { $0.code == code }
            // Skip if already resolved (optimistic UI already added it)
            guard !self.resolvedRequests.contains(where: { $0.code == code }) else { return }
            let seen = seenRequests[code]
            let resolved = ResolvedRequest(
                code: code,
                action: action,
                tool: seen?.tool ?? "",
                agentId: seen?.agentId ?? "",
                argsDisplay: seen?.argsDisplayString ?? ""
            )
            self.resolvedRequests.insert(resolved, at: 0)
            if self.resolvedRequests.count > Constants.maxResolvedRequests {
                self.resolvedRequests = Array(self.resolvedRequests.prefix(Constants.maxResolvedRequests))
            }
        }
    }

    private func startTimer() {
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { break }
                self.currentTime = Date()
            }
        }
    }
}
