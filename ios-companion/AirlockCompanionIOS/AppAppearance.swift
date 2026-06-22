import SwiftUI

enum AppAppearance: String, CaseIterable, Identifiable {
    case light
    case dark
    case system

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system:
            return "Auto"
        case .light:
            return "Light"
        case .dark:
            return "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system:
            return nil
        case .light:
            return .light
        case .dark:
            return .dark
        }
    }
}

enum DetailDecisionBehavior: String, CaseIterable, Identifiable {
    case showNext
    case returnToQueue

    var id: String { rawValue }

    var title: String {
        switch self {
        case .showNext:
            return "Show Next"
        case .returnToQueue:
            return "Return to Queue"
        }
    }
}

enum ForegroundNotificationBehavior: String, CaseIterable, Identifiable {
    case quiet
    case bannerAndSound

    var id: String { rawValue }

    var title: String {
        switch self {
        case .quiet:
            return "Quiet"
        case .bannerAndSound:
            return "Banner + Sound"
        }
    }
}
