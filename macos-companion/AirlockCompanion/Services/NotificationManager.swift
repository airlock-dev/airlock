import AppKit
import Foundation
import UserNotifications

@MainActor
final class NotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    var onAction: ((String, String) -> Void)?
    private var notificationCenter: UNUserNotificationCenter?
    private var isAvailable = false

    override init() {
        super.init()
        // UNUserNotificationCenter requires a valid app bundle.
        // Defer setup until requestAuthorization() is called.
    }

    func requestAuthorization() {
        guard Bundle.main.bundleIdentifier != nil else {
            print("NotificationManager: No bundle identifier — notifications disabled (run as .app bundle)")
            return
        }

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        self.notificationCenter = center
        self.isAvailable = true

        registerCategories()

        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func registerCategories() {
        guard let center = notificationCenter else { return }

        let approveAction = UNNotificationAction(
            identifier: Constants.NotificationCategory.approveAction,
            title: "Approve",
            options: [.foreground]
        )

        let denyAction = UNNotificationAction(
            identifier: Constants.NotificationCategory.denyAction,
            title: "Deny",
            options: [.destructive]
        )

        let category = UNNotificationCategory(
            identifier: Constants.NotificationCategory.approvalRequest,
            actions: [approveAction, denyAction],
            intentIdentifiers: [],
            options: []
        )

        center.setNotificationCategories([category])
    }

    func showNotification(for request: ApprovalRequest, soundEnabled: Bool = true) {
        guard let center = notificationCenter else { return }

        let content = UNMutableNotificationContent()
        content.title = "\(request.agentId): \(request.tool)"
        let argsStr = request.argsDisplayString
        if !argsStr.isEmpty {
            content.body = argsStr
        }
        content.categoryIdentifier = Constants.NotificationCategory.approvalRequest
        content.userInfo = ["code": request.code]

        if soundEnabled {
            content.sound = .default
        }

        let notificationRequest = UNNotificationRequest(
            identifier: request.code,
            content: content,
            trigger: nil
        )

        center.add(notificationRequest)

        // Play sound directly as well — UNNotification sounds can be silenced
        // by system notification settings
        if soundEnabled {
            NSSound(named: .init("Blow"))?.play()
        }
    }

    func showNotifyNotification(for request: ApprovalRequest, soundEnabled: Bool = true) {
        guard let center = notificationCenter else { return }

        let content = UNMutableNotificationContent()
        content.title = "Auto-approved: \(request.tool)"
        content.subtitle = request.agentId
        let argsStr = request.argsDisplayString
        if !argsStr.isEmpty {
            content.body = argsStr
        }
        // No category — no action buttons needed
        content.sound = nil  // Notify events are silent by default

        let notificationRequest = UNNotificationRequest(
            identifier: "notify-\(request.code)",
            content: content,
            trigger: nil
        )

        center.add(notificationRequest)
    }

    func removeNotification(code: String) {
        guard let center = notificationCenter else { return }
        center.removeDeliveredNotifications(withIdentifiers: [code])
        center.removePendingNotificationRequests(withIdentifiers: [code])
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        guard let code = userInfo["code"] as? String else {
            completionHandler()
            return
        }

        let actionIdentifier = response.actionIdentifier
        let action: String?

        switch actionIdentifier {
        case Constants.NotificationCategory.approveAction:
            action = "approved"
        case Constants.NotificationCategory.denyAction:
            action = "denied"
        default:
            action = nil
        }

        if let action {
            Task { @MainActor in
                self.onAction?(code, action)
            }
        }

        completionHandler()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
