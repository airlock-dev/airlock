import AppKit
import Foundation
import UserNotifications

@MainActor
final class NotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    var onAction: ((String, String, ApprovalRememberMode?, Int?) -> Void)?
    var onError: ((String) -> Void)?
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
            onError?("Notifications are unavailable outside the bundled app.")
            return
        }

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        self.notificationCenter = center
        self.isAvailable = true

        registerCategories()

        center.requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, error in
            if let error {
                Task { @MainActor in
                    self?.onError?("Notification authorization failed: \(error.localizedDescription)")
                }
                return
            }
            if !granted {
                Task { @MainActor in
                    self?.onError?("Notification permission is disabled in System Settings.")
                }
            }
        }
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

        let allowOneHourAction = UNNotificationAction(
            identifier: Constants.NotificationCategory.allowOneHourAction,
            title: "Allow 1 Hour",
            options: [.foreground]
        )

        let alwaysAllowAction = UNNotificationAction(
            identifier: Constants.NotificationCategory.alwaysAllowAction,
            title: "Always Allow",
            options: [.foreground]
        )

        let category = UNNotificationCategory(
            identifier: Constants.NotificationCategory.approvalRequest,
            actions: [approveAction, allowOneHourAction, alwaysAllowAction, denyAction],
            intentIdentifiers: [],
            options: []
        )

        center.setNotificationCategories([category])
    }

    func showNotification(for request: ApprovalRequest, soundEnabled: Bool = true) {
        guard let center = notificationCenter else { return }

        let content = UNMutableNotificationContent()
        content.title = request.displayTitle
        content.subtitle = request.displaySubtitle
        let lines = [
            request.requestReason.map { "Request reason: \($0)" },
            request.requestNote.map { "Request note: \($0)" },
            request.argsDisplayString.isEmpty ? nil : request.argsDisplayString
        ].compactMap { $0 }
        if !lines.isEmpty {
            content.body = lines.joined(separator: "\n")
        }
        content.categoryIdentifier = Constants.NotificationCategory.approvalRequest
        content.userInfo = [
            "approval_id": request.id,
            "code": request.code
        ]

        if soundEnabled {
            content.sound = .default
        }

        let notificationRequest = UNNotificationRequest(
            identifier: request.id,
            content: content,
            trigger: nil
        )

        center.add(notificationRequest) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in
                self?.onError?("Notification delivery failed: \(error.localizedDescription)")
            }
        }

        // Play sound directly as well — UNNotification sounds can be silenced
        // by system notification settings
        if soundEnabled {
            NSSound(named: .init("Blow"))?.play()
        }
    }

    func showNotification(for event: ActivityEvent, soundEnabled: Bool = true) {
        guard let center = notificationCenter else { return }
        guard event.kind == "notification" else { return }

        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.body

        if soundEnabled {
            content.sound = .default
        }

        let notificationRequest = UNNotificationRequest(
            identifier: event.id,
            content: content,
            trigger: nil
        )

        center.add(notificationRequest)

        if soundEnabled {
            NSSound(named: .init("Blow"))?.play()
        }
    }

    func removeNotification(id: String) {
        guard let center = notificationCenter else { return }
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        guard let approvalId = userInfo["approval_id"] as? String else {
            Task { @MainActor in
                self.onError?("Notification action did not include an approval id.")
            }
            completionHandler()
            return
        }

        let actionIdentifier = response.actionIdentifier
        let action: String?
        let remember: ApprovalRememberMode?
        let durationMs: Int?

        switch actionIdentifier {
        case Constants.NotificationCategory.approveAction:
            action = "approved"
            remember = nil
            durationMs = nil
        case Constants.NotificationCategory.allowOneHourAction:
            action = "approved"
            remember = .temporary
            durationMs = 60 * 60 * 1000
        case Constants.NotificationCategory.alwaysAllowAction:
            action = "approved"
            remember = .always
            durationMs = nil
        case Constants.NotificationCategory.denyAction:
            action = "denied"
            remember = nil
            durationMs = nil
        default:
            action = nil
            remember = nil
            durationMs = nil
        }

        if let action {
            Task { @MainActor in
                self.onAction?(approvalId, action, remember, durationMs)
            }
        } else {
            Task { @MainActor in
                self.onError?("Unsupported notification action: \(actionIdentifier)")
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
