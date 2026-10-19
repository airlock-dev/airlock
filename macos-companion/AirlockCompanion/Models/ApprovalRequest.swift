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

// MARK: - JSONValue

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
            return
        }
        if let boolValue = try? container.decode(Bool.self) {
            self = .bool(boolValue)
            return
        }
        if let doubleValue = try? container.decode(Double.self) {
            self = .number(doubleValue)
            return
        }
        if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
            return
        }
        if let arrayValue = try? container.decode([JSONValue].self) {
            self = .array(arrayValue)
            return
        }
        if let objectValue = try? container.decode([String: JSONValue].self) {
            self = .object(objectValue)
            return
        }

        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unable to decode JSONValue"
        )
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
            let items = values.map { $0.displayString }.joined(separator: ", ")
            return "[\(items)]"
        case .object(let dict):
            let items = dict.sorted(by: { $0.key < $1.key })
                .map { "\($0.key): \($0.value.displayString)" }
                .joined(separator: ", ")
            return "{\(items)}"
        }
    }

    var plainString: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}

// MARK: - Plans & grant options

/// One call inside a `kind == "plan"` request: the agent asked to approve several calls up front.
struct PlanEntry: Decodable, Equatable, Sendable {
    let tool: String
    let args: [String: JSONValue]
    var fingerprint: String? = nil

    enum CodingKeys: String, CodingKey {
        case tool, args, fingerprint
    }

    init(tool: String, args: [String: JSONValue] = [:], fingerprint: String? = nil) {
        self.tool = tool
        self.args = args
        self.fingerprint = fingerprint
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tool = try container.decode(String.self, forKey: .tool)
        args = (try? container.decodeIfPresent([String: JSONValue].self, forKey: .args)) ?? [:]
        fingerprint = try? container.decodeIfPresent(String.self, forKey: .fingerprint)
    }

    /// Single-line `key: value, …` rendering for compact plan lists.
    var compactArgs: String {
        args.sorted(by: { $0.key < $1.key })
            .map { "\($0.key): \($0.value.displayString)" }
            .joined(separator: ", ")
    }
}

/// A way the server offers to widen an approval into a grant ("Allow read-only gmail tools").
struct GrantOption: Decodable, Equatable, Hashable, Sendable {
    let scope: String
    let label: String
    var tier: String? = nil
    var profile: String? = nil

    /// The grant body for this option with a given lifetime.
    func spec(durationMs: Int?) -> GrantSpec {
        GrantSpec(scope: scope, tier: tier, profile: profile, durationMs: durationMs)
    }
}

/// Body of the `grant` field on a decision request.
struct GrantSpec: Encodable, Equatable, Sendable {
    let scope: String
    var tier: String? = nil
    var profile: String? = nil
    var durationMs: Int? = nil
    var maxUses: Int? = nil
    var sessionOnly: Bool? = nil

    enum CodingKeys: String, CodingKey {
        case scope, tier, profile
        case durationMs = "duration_ms"
        case maxUses = "max_uses"
        case sessionOnly = "session_only"
    }
}

// MARK: - ApprovalRequest

struct ApprovalContext: Codable, Equatable, Sendable {
    let reason: String?
    let note: String?
}

struct ApprovalRequest: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let code: String
    let agentId: String
    let tool: String
    let args: [String: JSONValue]
    let context: ApprovalContext?
    let timeoutMs: Int
    let receivedAt: Date
    let expiresAt: Date?
    // Newer gateways only; all optional and kept as raw strings so unknown values never fail decoding.
    var kind: String? = nil
    var mode: String? = nil
    var tier: String? = nil
    var provider: String? = nil
    var escalated: Bool = false
    var plan: [PlanEntry]? = nil
    var batchId: String? = nil
    var batchCode: String? = nil
    var batchSize: Int? = nil
    var grantOptions: [GrantOption] = []

    var deadline: Date {
        expiresAt ?? receivedAt.addingTimeInterval(TimeInterval(timeoutMs) / 1000.0)
    }

    var displayIdentifier: String {
        "ID \(String(id.suffix(8)))"
    }

    func isExpired(at date: Date = Date()) -> Bool {
        timeoutMs > 0 && deadline <= date
    }

    enum CodingKeys: String, CodingKey {
        case id, code, agentId, tool, args, context, timeoutMs, createdAt, expiresAt
        case kind, mode, tier, provider, escalated, plan, batchId, batchCode, batchSize, grantOptions
    }

    init(id: String, code: String, agentId: String, tool: String, args: [String: JSONValue], context: ApprovalContext? = nil, timeoutMs: Int, receivedAt: Date = Date(), expiresAt: Date? = nil) {
        self.id = id
        self.code = code
        self.agentId = agentId
        self.tool = tool
        self.args = args
        self.context = context
        self.timeoutMs = timeoutMs
        self.receivedAt = receivedAt
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        code = try container.decode(String.self, forKey: .code)
        agentId = try container.decode(String.self, forKey: .agentId)
        tool = try container.decode(String.self, forKey: .tool)
        args = try container.decode([String: JSONValue].self, forKey: .args)
        context = try container.decodeIfPresent(ApprovalContext.self, forKey: .context)
        timeoutMs = try container.decode(Int.self, forKey: .timeoutMs)
        let createdAtValue = try container.decodeIfPresent(String.self, forKey: .createdAt)
        let expiresAtValue = try container.decodeIfPresent(String.self, forKey: .expiresAt)
        receivedAt = Self.parseDate(createdAtValue) ?? Date()
        expiresAt = Self.parseDate(expiresAtValue)
        kind = try? container.decodeIfPresent(String.self, forKey: .kind)
        mode = try? container.decodeIfPresent(String.self, forKey: .mode)
        tier = try? container.decodeIfPresent(String.self, forKey: .tier)
        provider = try? container.decodeIfPresent(String.self, forKey: .provider)
        escalated = ((try? container.decodeIfPresent(Bool.self, forKey: .escalated)) ?? nil) ?? false
        plan = try? container.decodeIfPresent([PlanEntry].self, forKey: .plan)
        batchId = try? container.decodeIfPresent(String.self, forKey: .batchId)
        batchCode = try? container.decodeIfPresent(String.self, forKey: .batchCode)
        batchSize = try? container.decodeIfPresent(Int.self, forKey: .batchSize)
        grantOptions = ((try? container.decodeIfPresent([GrantOption].self, forKey: .grantOptions)) ?? nil) ?? []
    }

    static func parseDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }

        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }

    var argsDisplayString: String {
        args.sorted(by: { $0.key < $1.key })
            .map { "  \($0.key): \($0.value.displayString)" }
            .joined(separator: "\n")
    }

    var requestReason: String? {
        let trimmed = context?.reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    var requestNote: String? {
        let trimmed = context?.note?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    var isUserQuestion: Bool {
        kind == "question" || tool == "airlock/ask_user"
    }

    var isPlan: Bool {
        kind == "plan" && !(plan ?? []).isEmpty
    }

    var planEntries: [PlanEntry] {
        plan ?? []
    }

    /// Safety tier badge text, when the gateway classified the tool.
    var tierLabel: String? {
        guard let tier, !tier.isEmpty else { return nil }
        return tier.capitalized
    }

    /// Key used to group requests for "Approve all": the notification batch when there is one,
    /// otherwise the requesting agent.
    var groupKey: String {
        if let batchId, !batchId.isEmpty { return "batch:\(batchId)" }
        return "agent:\(agentId)"
    }

    /// Escalated requests and questions must be read and decided one by one.
    /// Matches the server's bulk-approve rule: routine tool calls only. Flagged calls, plans and
    /// questions each need their own decision.
    var canBulkApprove: Bool {
        !escalated && !isUserQuestion && !isPlan
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

    var displayTitle: String {
        if isUserQuestion { return questionText }
        if isPlan { return "Plan: \(planEntries.count) calls" }
        return tool
    }

    var displaySubtitle: String {
        isUserQuestion ? "\(agentId) · user question" : agentId
    }

    var approveLabel: String {
        isUserQuestion ? "Confirm" : "Approve"
    }
}

// MARK: - ApprovalGroup

/// Pending requests decided together: a notification batch, or several requests from one agent.
struct ApprovalGroup: Identifiable, Equatable, Sendable {
    let id: String
    let agentId: String
    let batchCode: String?
    let requests: [ApprovalRequest]

    var ids: [String] { requests.map(\.id) }

    /// Ids "Approve all" sends: escalated requests and questions are left for individual review.
    var approvableIds: [String] { requests.filter(\.canBulkApprove).map(\.id) }

    var flaggedCount: Int { requests.filter(\.escalated).count }

    var title: String {
        if let batchCode, !batchCode.isEmpty { return "\(agentId) · batch \(batchCode)" }
        return agentId
    }

    /// Groups of two or more, ordered by where their first request appears in `requests`.
    static func groups(from requests: [ApprovalRequest]) -> [ApprovalGroup] {
        var order: [String] = []
        var members: [String: [ApprovalRequest]] = [:]
        for request in requests {
            let key = request.groupKey
            if members[key] == nil { order.append(key) }
            members[key, default: []].append(request)
        }
        return order.compactMap { key in
            guard let items = members[key], items.count >= 2, let first = items.first else { return nil }
            return ApprovalGroup(id: key, agentId: first.agentId, batchCode: first.batchCode, requests: items)
        }
    }
}

// MARK: - ResolvedRequest

struct ResolvedRequest: Identifiable, Equatable, Sendable {
    let id: String
    let code: String
    let action: String
    let tool: String
    let agentId: String
    let title: String
    let detail: String
    let argsDisplay: String
    let resolvedAt: Date

    init(
        id: String,
        code: String,
        action: String,
        tool: String = "",
        agentId: String = "",
        title: String = "",
        detail: String = "",
        argsDisplay: String = "",
        resolvedAt: Date = Date()
    ) {
        self.id = id
        self.code = code
        self.action = action
        self.tool = tool
        self.agentId = agentId
        self.title = title
        self.detail = detail
        self.argsDisplay = argsDisplay
        self.resolvedAt = resolvedAt
    }

    var displayTitle: String {
        if !title.isEmpty { return title }
        if !agentId.isEmpty && !tool.isEmpty { return "\(agentId): \(tool)" }
        if !tool.isEmpty { return tool }
        return "ID \(String(id.suffix(8)))"
    }

    var displayDetail: String {
        if !detail.isEmpty { return detail }
        if !agentId.isEmpty { return agentId }
        return action
    }
}

// MARK: - ActivityEvent

struct ActivityEvent: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let agentId: String
    let title: String
    let body: String
    let severity: String
    let createdAt: String

    var displayTitle: String {
        title.isEmpty ? (kind == "notification" ? "Airlock notification" : "Airlock log") : title
    }

    var displayBody: String {
        body.isEmpty ? agentId : body
    }

    var createdDate: Date {
        Self.iso8601WithFractionalSeconds.date(from: createdAt)
            ?? Self.iso8601.date(from: createdAt)
            ?? .distantPast
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let iso8601WithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
