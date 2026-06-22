import Foundation

enum Constants {
    static let defaultDashboardURL = "http://127.0.0.1:4113"
    static let sseEventsPath = "/events"
    static let healthPath = "/health"
    static let approvePath = "/approve"
    static let denyPath = "/deny"

    enum UserDefaultsKeys {
        static let dashboardURL = "dashboardURL"
        static let gatewayToken = "gatewayToken"
        static let soundEnabled = "soundEnabled"
        static let approveShortcutKey = "approveShortcutKey"
        static let denyShortcutKey = "denyShortcutKey"
        static let autoExpandSelectedRequest = "autoExpandSelectedRequest"
        static let displayDensity = "displayDensity"
        static let lastNotificationActionError = "lastNotificationActionError"
        static let lastNotificationDeliveryError = "lastNotificationDeliveryError"
    }

    enum NotificationCategory {
        static let approvalRequest = "APPROVAL_REQUEST"
        static let approveAction = "APPROVE_ACTION"
        static let allowOneHourAction = "ALLOW_ONE_HOUR_ACTION"
        static let alwaysAllowAction = "ALWAYS_ALLOW_ACTION"
        static let denyAction = "DENY_ACTION"
    }

    static let maxResolvedRequests = 20
    static let popoverWidth: CGFloat = 360
    static let popoverMaxHeight: CGFloat = 500

    enum Reconnect {
        static let initialDelay: TimeInterval = 1.0
        static let maxDelay: TimeInterval = 30.0
        static let multiplier: Double = 2.0
    }

    enum Updates {
        static let repositoryOwner = "airlock-dev"
        static let repositoryName = "airlock"
        static let tagPrefix = "companion-v"
        static let checkInterval: TimeInterval = 3600
        static let releasesURL = URL(string: "https://api.github.com/repos/\(repositoryOwner)/\(repositoryName)/releases?per_page=20")!
    }
}
