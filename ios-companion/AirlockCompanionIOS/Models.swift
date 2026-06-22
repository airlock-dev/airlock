import Foundation

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
}

struct ApprovalRequest: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let code: String
    let agentId: String
    let tool: String
    let args: [String: JSONValue]
    let status: String?
    let reason: String?
    let createdAt: Date
    let timeoutMs: Int?
    let expiresAt: Date?
    let resolvedAt: Date?

    var argsPreview: String {
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

    var effectiveExpiresAt: Date? {
        if let expiresAt { return expiresAt }
        guard let timeoutMs, timeoutMs > 0 else { return nil }
        return createdAt.addingTimeInterval(Double(timeoutMs) / 1000)
    }

    func isExpired(at date: Date = Date()) -> Bool {
        guard let effectiveExpiresAt else { return false }
        return effectiveExpiresAt <= date
    }
}

struct ApprovalListResponse: Decodable {
    let approvals: [ApprovalRequest]
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

struct DecisionRequest: Encodable {
    let decision: ApprovalDecision
    let remember: RememberMode?
    let durationMs: Int?
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case decision
        case remember
        case durationMs = "duration_ms"
        case reason
    }
}
