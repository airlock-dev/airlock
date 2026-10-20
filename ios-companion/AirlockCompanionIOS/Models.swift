import Foundation

struct ApprovalPreviewField: Decodable, Sendable {
    let label: String
    let value: String
    var primary: Bool? = nil
}

struct ApprovalPreview: Decodable, Sendable {
    let status: String
    var tool: String? = nil
    var text: String? = nil
    var truncated: Bool? = nil
    var message: String? = nil
    var fields: [ApprovalPreviewField]? = nil
    var requestedFields: [ApprovalPreviewField]? = nil
}

enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unable to decode JSONValue"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    var displayString: String {
        switch self {
        case .string(let value):
            return "\"\(value)\""
        case .number(let value):
            if value == value.rounded() && !value.isInfinite {
                return String(format: "%.0f", value)
            }
            return String(value)
        case .bool(let value):
            return String(value)
        case .null:
            return "null"
        case .array(let values):
            return "[" + values.map(\.displayString).joined(separator: ", ") + "]"
        case .object(let object):
            let body = object
                .sorted { $0.key < $1.key }
                .map { "\($0.key): \($0.value.displayString)" }
                .joined(separator: ", ")
            return "{\(body)}"
        }
    }

    var plainString: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}

struct ApprovalRequest: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let code: String
    let agentId: String
    let tool: String
    let args: [String: JSONValue]
    let status: String?
    let reason: String?
    let note: String?
    let createdAt: Date
    let timeoutMs: Int?
    let expiresAt: Date?
    let resolvedAt: Date?
    var kind: String? = nil
    var mode: String? = nil
    var tier: String? = nil
    var provider: String? = nil
    var escalated: Bool? = nil
    var plan: [PlanEntry]? = nil
    var batchId: String? = nil
    var batchCode: String? = nil
    var grantOptions: [GrantOption]? = nil

    var argsPreview: String {
        if isUserQuestion {
            return questionContext ?? "User response requested"
        }
        if isPlan, let plan {
            let tools = plan.prefix(3).map(\.tool).joined(separator: ", ")
            let remaining = plan.count > 3 ? ", +\(plan.count - 3) more" : ""
            return "\(plan.count) planned calls: " + tools + remaining
        }
        if let requestReason {
            return requestReason
        }
        let keys = args.keys.sorted()
        if keys.isEmpty { return "No arguments" }
        let visible = keys.prefix(5).joined(separator: ", ")
        let remaining = keys.count > 5 ? ", +\(keys.count - 5) more" : ""
        return visible + remaining
    }

    var argsDisplayString: String {
        args.sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value.displayString)" }
            .joined(separator: "\n")
    }

    var displayIdentifier: String {
        "ID \(String(id.suffix(8)))"
    }

    var effectiveExpiresAt: Date? {
        if let expiresAt { return expiresAt }
        guard let timeoutMs, timeoutMs > 0 else { return nil }
        return createdAt.addingTimeInterval(Double(timeoutMs) / 1000)
    }

    func isExpired(at date: Date = Date()) -> Bool {
        guard let effectiveExpiresAt else { return false }
        return effectiveExpiresAt <= date
    }

    var isUserQuestion: Bool {
        kind == "question" || tool == "airlock/ask_user"
    }

    var isPlan: Bool {
        kind == "plan" && !(plan ?? []).isEmpty
    }

    /// Flagged by a security check: reviewed one at a time, never bulk-approved or widened into a grant.
    var isBulkApprovable: Bool {
        !isEscalated && !isPlan && !isUserQuestion
    }

    var isEscalated: Bool {
        escalated == true
    }

    var availableGrantOptions: [GrantOption] {
        isEscalated || isUserQuestion ? [] : (grantOptions ?? [])
    }

    var questionText: String {
        args["question"]?.plainString?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? args["title"]?.plainString?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? args["message"]?.plainString?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? "Question from agent"
    }

    var questionContext: String? {
        let value = args["context"]?.plainString ?? args["reason"]?.plainString
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    var requestReason: String? {
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    var requestNote: String? {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    var displayTitle: String {
        if isUserQuestion { return questionText }
        if isPlan { return "Plan: \(plan?.count ?? 0) calls" }
        return tool
    }

    var displaySubtitle: String {
        if isUserQuestion { return "\(agentId) · user question" }
        if isPlan { return "\(agentId) · plan" }
        if let tier { return "\(agentId) · \(tier)" }
        return agentId
    }

    var approveLabel: String {
        isUserQuestion ? "Confirm" : "Approve"
    }
}

struct PlanEntry: Codable, Equatable, Sendable {
    let tool: String
    var args: [String: JSONValue]? = nil
    var fingerprint: String? = nil

    var compactArgs: String {
        guard let args, !args.isEmpty else { return "No arguments" }
        return args.sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value.displayString)" }
            .joined(separator: ", ")
    }
}

struct GrantOption: Codable, Equatable, Hashable, Sendable {
    let scope: String
    let label: String
    var tier: String? = nil
    var profile: String? = nil
}

struct ApprovalListResponse: Decodable {
    let approvals: [ApprovalRequest]
}

/// A pending batch: approvals notified together that can be decided at once.
struct ApprovalBatch: Identifiable, Equatable {
    let id: String
    let code: String?
    let approvals: [ApprovalRequest]

    /// Matches the server's bulk-approve rule: routine tool calls only. Flagged calls, plans and
    /// questions each need their own decision.
    var approvableIds: [String] {
        approvals.filter(\.isBulkApprovable).map(\.id)
    }

    var flaggedCount: Int {
        approvals.filter(\.isEscalated).count
    }

    /// Plans and questions in the batch, which Approve All leaves for individual review.
    var individualReviewCount: Int {
        approvals.filter { !$0.isEscalated && !$0.isBulkApprovable }.count
    }
}

struct GrantScopeInfo: Decodable, Equatable, Sendable {
    let kind: String
    var tool: String? = nil
    var tier: String? = nil
    var provider: String? = nil
    var profile: String? = nil

    var displayString: String {
        switch kind {
        case "call":
            return "One call to \(tool ?? "tool")"
        case "tool":
            return "Any call to \(tool ?? "tool")"
        case "tier":
            let base = "\((tier ?? "read").capitalized)-tier tools"
            return provider.map { "\(base) from \($0)" } ?? base
        case "provider":
            return "Any \(provider ?? "provider") tool"
        case "profile":
            return "Profile \(profile ?? "")"
        default:
            return kind
        }
    }
}

struct ApprovalGrant: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let agentId: String
    let scope: GrantScopeInfo
    let source: String
    var label: String? = nil
    let createdAt: Date
    var expiresAt: Date? = nil
    var usesRemaining: Int? = nil

    var displayTitle: String {
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed! : scope.displayString
    }

    func isExpired(at date: Date = Date()) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt <= date
    }
}

struct GrantListResponse: Decodable {
    let grants: [ApprovalGrant]
}

/// Decision responses: `approved` may include other pending ids a new grant auto-approved.
struct DecisionResponse: Decodable {
    var ok: Bool? = nil
    var approved: [String]? = nil
    var skipped: [String]? = nil
    var denied: [String]? = nil
    var grant: ApprovalGrant? = nil
}

struct ActivityEvent: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let agentId: String
    let title: String
    let body: String
    let severity: String
    let createdAt: Date

    var displayTitle: String {
        title.isEmpty ? (kind == "notification" ? "Airlock notification" : "Airlock log") : title
    }

    var displayBody: String {
        body.isEmpty ? agentId : body
    }
}

struct ActivityListResponse: Decodable {
    let events: [ActivityEvent]
}

struct DeviceRegistrationResponse: Decodable {
    let id: String
    let token: String
}

enum ApprovalDecision: String, Encodable {
    case approved
    case denied
}

enum RememberMode: String, Encodable {
    case temporary
    case always
}

/// Approve and also allow similar calls for a while.
struct GrantRequest: Encodable, Equatable {
    let scope: String
    var tier: String? = nil
    var profile: String? = nil
    var durationMs: Int? = nil
    var maxUses: Int? = nil
    var sessionOnly: Bool? = nil

    init(
        scope: String,
        tier: String? = nil,
        profile: String? = nil,
        durationMs: Int? = nil,
        maxUses: Int? = nil,
        sessionOnly: Bool? = nil
    ) {
        self.scope = scope
        self.tier = tier
        self.profile = profile
        self.durationMs = durationMs
        self.maxUses = maxUses
        self.sessionOnly = sessionOnly
    }

    init(option: GrantOption, durationMs: Int) {
        self.init(scope: option.scope, tier: option.tier, profile: option.profile, durationMs: durationMs)
    }

    enum CodingKeys: String, CodingKey {
        case scope
        case tier
        case profile
        case durationMs = "duration_ms"
        case maxUses = "max_uses"
        case sessionOnly = "session_only"
    }
}

enum GrantDuration: Int, CaseIterable, Identifiable {
    case fifteenMinutes = 900_000
    case oneHour = 3_600_000
    case eightHours = 28_800_000

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .fifteenMinutes:
            return "15 Minutes"
        case .oneHour:
            return "1 Hour"
        case .eightHours:
            return "8 Hours"
        }
    }
}

struct DecisionRequest: Encodable {
    let decision: ApprovalDecision
    let remember: RememberMode?
    let durationMs: Int?
    let reason: String?
    var grant: GrantRequest? = nil

    enum CodingKeys: String, CodingKey {
        case decision
        case remember
        case durationMs = "duration_ms"
        case reason
        case grant
    }
}

struct BulkDecisionRequest: Encodable {
    let ids: [String]
    let decision: ApprovalDecision
    let reason: String?
}

struct BatchDecisionRequest: Encodable {
    let decision: ApprovalDecision
    let reason: String?
}
