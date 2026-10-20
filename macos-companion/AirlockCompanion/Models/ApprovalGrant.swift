import Foundation

/// An active approval grant: calls matching `scope` from `agentId` skip approval until it
/// expires or runs out of uses.
struct ApprovalGrant: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let agentId: String
    /// Raw scope object, e.g. `{ "kind": "tier", "tier": "read", "provider": "gmail" }`.
    let scope: [String: JSONValue]
    var source: String? = nil
    var label: String? = nil
    var createdAt: Date? = nil
    var expiresAt: Date? = nil
    var usesRemaining: Int? = nil

    enum CodingKeys: String, CodingKey {
        case id, agentId, scope, source, label, createdAt, expiresAt, usesRemaining
    }

    init(
        id: String,
        agentId: String,
        scope: [String: JSONValue],
        source: String? = nil,
        label: String? = nil,
        createdAt: Date? = nil,
        expiresAt: Date? = nil,
        usesRemaining: Int? = nil
    ) {
        self.id = id
        self.agentId = agentId
        self.scope = scope
        self.source = source
        self.label = label
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.usesRemaining = usesRemaining
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        agentId = (try? container.decodeIfPresent(String.self, forKey: .agentId)) ?? ""
        scope = ((try? container.decodeIfPresent([String: JSONValue].self, forKey: .scope)) ?? nil) ?? [:]
        source = try? container.decodeIfPresent(String.self, forKey: .source)
        label = try? container.decodeIfPresent(String.self, forKey: .label)
        createdAt = ApprovalRequest.parseDate((try? container.decodeIfPresent(String.self, forKey: .createdAt)) ?? nil)
        expiresAt = ApprovalRequest.parseDate((try? container.decodeIfPresent(String.self, forKey: .expiresAt)) ?? nil)
        usesRemaining = try? container.decodeIfPresent(Int.self, forKey: .usesRemaining)
    }

    var scopeKind: String {
        scope["kind"]?.plainString ?? "unknown"
    }

    /// Human description of what the grant covers, used when the server sent no label.
    var scopeDescription: String {
        let tool = scope["tool"]?.plainString
        let provider = scope["provider"]?.plainString
        switch scopeKind {
        case "call":
            return "One exact \(tool ?? "call")"
        case "tool":
            return tool ?? "Tool"
        case "tier":
            let tier = scope["tier"]?.plainString == "read" ? "Read-only" : "Non-destructive"
            return provider.map { "\(tier) \($0) tools" } ?? "\(tier) tools"
        case "provider":
            return "All \(provider ?? "provider") tools"
        case "profile":
            return "Profile \(scope["profile"]?.plainString ?? "")"
        default:
            return scopeKind
        }
    }

    var displayTitle: String {
        if let label, !label.isEmpty { return label }
        return scopeDescription
    }

    func isExpired(at date: Date = Date()) -> Bool {
        if let expiresAt, expiresAt <= date { return true }
        if let usesRemaining, usesRemaining <= 0 { return true }
        return false
    }

    /// "expires in 12m · 3 uses left" style summary.
    func statusText(at date: Date = Date()) -> String {
        var parts: [String] = []
        if let expiresAt {
            parts.append("expires in \(Self.formatRemaining(expiresAt.timeIntervalSince(date)))")
        } else {
            parts.append("until revoked")
        }
        if let usesRemaining {
            parts.append(usesRemaining == 1 ? "1 use left" : "\(usesRemaining) uses left")
        }
        return parts.joined(separator: " · ")
    }

    static func formatRemaining(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder == 0 ? "\(hours)h" : "\(hours)h \(remainder)m"
    }
}

/// Lifetimes offered by the "Approve & allow…" menu.
enum GrantDuration: CaseIterable, Sendable {
    case fifteenMinutes
    case oneHour
    case eightHours

    var label: String {
        switch self {
        case .fifteenMinutes: return "15 minutes"
        case .oneHour: return "1 hour"
        case .eightHours: return "8 hours"
        }
    }

    var milliseconds: Int {
        switch self {
        case .fifteenMinutes: return 15 * 60 * 1000
        case .oneHour: return 60 * 60 * 1000
        case .eightHours: return 8 * 60 * 60 * 1000
        }
    }
}
