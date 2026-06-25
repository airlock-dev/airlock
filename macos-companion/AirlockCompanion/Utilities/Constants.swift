import Foundation

enum Constants {
    static let defaultDashboardURL = "http://127.0.0.1:4113"
    static let sseEventsPath = "/mobile/approvals/stream"
    static let healthPath = "/health"
    static let pendingPath = "/mobile/approvals"

    static func approvalDecisionPath(id: String) -> String {
        "/mobile/approvals/\(id)/decision"
    }

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

    enum LegacyDefaults {
        static let suiteNames = [
            "com.airlock.companion"
        ]
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
        static let openTimeout: TimeInterval = 5.0
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

    enum PendingMaintenance {
        static let pruneInterval: TimeInterval = 1.0
        static let reconcileInterval: TimeInterval = 5.0
    }
}
