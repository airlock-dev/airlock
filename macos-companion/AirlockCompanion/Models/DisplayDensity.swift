import CoreGraphics
import Foundation

enum DisplayDensity: String, CaseIterable {
    case compact
    case comfortable
    case decadent

    var popoverWidth: CGFloat {
        switch self {
        case .compact: return 360
        case .comfortable: return 480
        case .decadent: return 640
        }
    }

    var popoverMaxHeight: CGFloat {
        switch self {
        case .compact: return 500
        case .comfortable: return 640
        case .decadent: return 800
        }
    }

    var displayName: String {
        switch self {
        case .compact: return "Compact"
        case .comfortable: return "Comfortable"
        case .decadent: return "Decadent"
        }
    }
}
