import Foundation

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
}

// MARK: - ApprovalRequest

struct ApprovalRequest: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let code: String
    let agentId: String
    let tool: String
    let args: [String: JSONValue]
    let timeoutMs: Int
    let receivedAt: Date

    var deadline: Date {
        receivedAt.addingTimeInterval(TimeInterval(timeoutMs) / 1000.0)
    }

    func isExpired(at date: Date = Date()) -> Bool {
        timeoutMs > 0 && deadline <= date
    }

    enum CodingKeys: String, CodingKey {
        case id, code, agentId, tool, args, timeoutMs
    }

    init(id: String, code: String, agentId: String, tool: String, args: [String: JSONValue], timeoutMs: Int, receivedAt: Date = Date()) {
        self.id = id
        self.code = code
        self.agentId = agentId
        self.tool = tool
        self.args = args
        self.timeoutMs = timeoutMs
        self.receivedAt = receivedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        code = try container.decode(String.self, forKey: .code)
        agentId = try container.decode(String.self, forKey: .agentId)
        tool = try container.decode(String.self, forKey: .tool)
        args = try container.decode([String: JSONValue].self, forKey: .args)
        timeoutMs = try container.decode(Int.self, forKey: .timeoutMs)
        receivedAt = Date()
    }

    var argsDisplayString: String {
        args.sorted(by: { $0.key < $1.key })
            .map { "  \($0.key): \($0.value.displayString)" }
            .joined(separator: "\n")
    }
}

// MARK: - ResolvedRequest

struct ResolvedRequest: Identifiable, Equatable, Sendable {
    let id: String
    let code: String
    let action: String
    let tool: String
    let agentId: String
    let argsDisplay: String
    let resolvedAt: Date

    init(code: String, action: String, tool: String = "", agentId: String = "", argsDisplay: String = "", resolvedAt: Date = Date()) {
        self.id = code
        self.code = code
        self.action = action
        self.tool = tool
        self.agentId = agentId
        self.argsDisplay = argsDisplay
        self.resolvedAt = resolvedAt
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
}
