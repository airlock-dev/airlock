import Foundation
import SwiftUI
import UIKit
import UserNotifications

extension Notification.Name {
    static let airlockShouldRefresh = Notification.Name("airlockShouldRefresh")
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        NotificationManager.shared.configure()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "apnsToken")

        guard let client = NotificationManager.shared.clientFromDefaults(),
              !UserDefaults.standard.string(forKey: "deviceToken", default: "").isEmpty
        else { return }

        Task {
            try? await client.updateDevicePushToken(token)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        UserDefaults.standard.set(error.localizedDescription, forKey: "lastPushRegistrationError")
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            let handled = await NotificationManager.shared.handleRemoteNotification(userInfo: userInfo)
            completionHandler(handled ? .newData : .noData)
        }
    }
}

@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    private override init() {
        super.init()
    }

    func configure() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([approvalCategory, activityCategory])
    }

    func requestAuthorization() {
        configure()
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { _, _ in }
    }

    func sendLocalDiagnosticNotification() {
        configure()

        let content = UNMutableNotificationContent()
        content.title = "dev: echo/add"
        content.body = """
        command: npm run typecheck
        cwd: /srv/airlock
        timeout_ms: 120000
        """
        content.categoryIdentifier = "AIRLOCK_APPROVAL"
        content.sound = .default
        content.userInfo = [
            "approval_id": "local-diagnostic",
            "code": "LOCAL01",
            "tool": "echo/add",
            "agent_id": "dev",
            "airlock": [
                "approval": [
                    "id": "local-diagnostic",
                    "code": "LOCAL01",
                    "agentId": "dev",
                    "tool": "echo/add",
                    "args": [
                        ["key": "command", "value": "npm run typecheck"],
                        ["key": "cwd", "value": "/srv/airlock"],
                        ["key": "timeout_ms", "value": "120000"],
                    ],
                    "timeoutMs": 300000,
                    "expiresAt": localDiagnosticExpirationString(),
                ],
            ],
        ]

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 2, repeats: false)
        let request = UNNotificationRequest(
            identifier: "airlock-local-diagnostic-\(UUID().uuidString)",
            content: content,
            trigger: trigger
        )
        UNUserNotificationCenter.current().add(request)
    }

    private func localDiagnosticExpirationString() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(300))
    }

    private var approvalCategory: UNNotificationCategory {
        let approve = UNNotificationAction(
            identifier: "APPROVE",
            title: "Approve",
            options: [.authenticationRequired]
        )
        let allowOneHour = UNNotificationAction(
            identifier: "ALLOW_ONE_HOUR",
            title: "Allow 1 Hour",
            options: [.authenticationRequired]
        )
        let alwaysAllow = UNNotificationAction(
            identifier: "ALWAYS_ALLOW",
            title: "Always Allow",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: "DENY",
            title: "Deny",
            options: [.destructive, .authenticationRequired]
        )

        return UNNotificationCategory(
            identifier: "AIRLOCK_APPROVAL",
            actions: [approve, allowOneHour, alwaysAllow, deny],
            intentIdentifiers: [],
            options: []
        )
    }

    private var activityCategory: UNNotificationCategory {
        UNNotificationCategory(
            identifier: "AIRLOCK_ACTIVITY",
            actions: [],
            intentIdentifiers: [],
            options: []
        )
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in
            await handle(response: response)
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        Task { @MainActor in
            postRefresh()
            completionHandler(foregroundPresentationOptions())
        }
    }

    private func foregroundPresentationOptions() -> UNNotificationPresentationOptions {
        let rawValue = UserDefaults.standard.string(forKey: "foregroundNotificationBehavior")
            ?? ForegroundNotificationBehavior.quiet.rawValue
        switch ForegroundNotificationBehavior(rawValue: rawValue) ?? .quiet {
        case .quiet:
            return [.badge]
        case .bannerAndSound:
            return [.banner, .sound, .badge]
        }
    }

    private func handle(response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        if isActivityNotification(userInfo: userInfo) {
            postRefresh()
            return
        }

        let approvalId = userInfo["approval_id"] as? String
        guard let approvalId else {
            UserDefaults.standard.set("Notification did not include an approval id.", forKey: "lastNotificationActionError")
            postRefresh()
            return
        }

        guard let client = clientFromDefaults() else {
            UserDefaults.standard.set("Airlock URL or device token is missing.", forKey: "lastNotificationActionError")
            postRefresh()
            return
        }

        guard ["APPROVE", "ALLOW_ONE_HOUR", "ALWAYS_ALLOW", "DENY"].contains(response.actionIdentifier) else {
            await refreshApprovalNotifications(using: client)
            postRefresh()
            return
        }

        do {
            let pending = try await client.pendingApprovals()
            guard pending.contains(where: { $0.id == approvalId && !$0.isExpired() }) else {
                throw AirlockAPIError.alreadyResolved
            }
            switch response.actionIdentifier {
            case "APPROVE":
                try await client.decide(id: approvalId, decision: .approved)
            case "ALLOW_ONE_HOUR":
                try await client.decide(
                    id: approvalId,
                    decision: .approved,
                    remember: .temporary,
                    durationMs: 60 * 60 * 1000
                )
            case "ALWAYS_ALLOW":
                try await client.decide(id: approvalId, decision: .approved, remember: .always)
            case "DENY":
                try await client.decide(id: approvalId, decision: .denied, reason: "Denied from iOS notification")
            default:
                break
            }
            UserDefaults.standard.removeObject(forKey: "lastNotificationActionError")
            await removeDeliveredApprovalNotification(matching: approvalId)
        } catch AirlockAPIError.alreadyResolved {
            UserDefaults.standard.set(AirlockAPIError.alreadyResolved.localizedDescription, forKey: "lastNotificationActionError")
            await removeDeliveredApprovalNotification(matching: approvalId)
        } catch {
            UserDefaults.standard.set(error.localizedDescription, forKey: "lastNotificationActionError")
        }

        await refreshApprovalNotifications(using: client)
        postRefresh()
    }

    func handleRemoteNotification(userInfo: [AnyHashable: Any]) async -> Bool {
        if isActivityNotification(userInfo: userInfo) {
            postRefresh()
            return true
        }

        guard userInfo["event"] as? String == "approval_resolved" else {
            postRefresh()
            return false
        }

        // Finish local cleanup before returning to iOS's background completion handler,
        // even when the management API is unreachable.
        if let approvalId = userInfo["approval_id"] as? String {
            await removeDeliveredApprovalNotification(matching: approvalId)
        } else if let code = userInfo["code"] as? String {
            await removeDeliveredApprovalNotification(matching: code)
        }
        if let client = clientFromDefaults() {
            await refreshApprovalNotifications(using: client)
        }
        postRefresh()
        return true
    }

    func removeDeliveredApprovalNotification(matching idOrCode: String) async {
        let center = UNUserNotificationCenter.current()
        let notifications = await center.deliveredNotifications()
        let identifiers = notifications.compactMap { notification -> String? in
            guard notification.request.content.categoryIdentifier == "AIRLOCK_APPROVAL" else { return nil }
            let userInfo = notification.request.content.userInfo
            let matches = userInfo["approval_id"] as? String == idOrCode || userInfo["code"] as? String == idOrCode
            return matches ? notification.request.identifier : nil
        }
        // APNs chooses request identifiers; map the payload's approval identity to them.
        if !identifiers.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: identifiers)
        }
    }

    func reconcileApprovalNotifications(with approvals: [ApprovalRequest], fetchedAfter: Date) async {
        let active = approvals.filter { !$0.isExpired() }
        let activeIds = Set(active.map(\.id))
        let activeCodes = Set(active.map(\.code))
        let center = UNUserNotificationCenter.current()
        let notifications = await center.deliveredNotifications()
        let identifiers = notifications.compactMap { notification -> String? in
            // A notification arriving during the fetch may be newer than its snapshot.
            guard notification.date <= fetchedAfter,
                  notification.request.content.categoryIdentifier == "AIRLOCK_APPROVAL"
            else { return nil }
            let userInfo = notification.request.content.userInfo
            if let id = userInfo["approval_id"] as? String {
                return activeIds.contains(id) ? nil : notification.request.identifier
            }
            if let code = userInfo["code"] as? String {
                return activeCodes.contains(code) ? nil : notification.request.identifier
            }
            return nil
        }
        if !identifiers.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: identifiers)
        }
        if #available(iOS 17.0, *) {
            try? await center.setBadgeCount(active.count)
        } else {
            UIApplication.shared.applicationIconBadgeNumber = active.count
        }
    }

    private func refreshApprovalNotifications(using client: AirlockAPIClient) async {
        let startedAt = Date()
        // Background execution has a limited budget. A failed fetch must not be
        // interpreted as an empty queue or prevent explicit resolution cleanup.
        guard let approvals = try? await client.pendingApprovals(timeoutInterval: 10) else { return }
        await reconcileApprovalNotifications(with: approvals, fetchedAfter: startedAt)
    }

    func clientFromDefaults() -> AirlockAPIClient? {
        let defaults = UserDefaults.standard
        guard let baseURLString = defaults.string(forKey: "baseURL"),
              let baseURL = URL(string: baseURLString)
        else { return nil }

        let deviceToken = defaults.string(forKey: "deviceToken", default: "")
        let adminSecret = defaults.string(forKey: "adminSecret", default: "")
        let bearer = deviceToken.isEmpty ? adminSecret : deviceToken
        guard !bearer.isEmpty else { return nil }
        return AirlockAPIClient(baseURL: baseURL, bearerToken: bearer)
    }

    private func postRefresh() {
        NotificationCenter.default.post(name: .airlockShouldRefresh, object: nil)
    }

    private func isActivityNotification(userInfo: [AnyHashable: Any]) -> Bool {
        userInfo["event"] as? String == "activity" || userInfo["activity_id"] is String
    }
}

private extension UserDefaults {
    func string(forKey key: String, default defaultValue: String) -> String {
        string(forKey: key) ?? defaultValue
    }
}
