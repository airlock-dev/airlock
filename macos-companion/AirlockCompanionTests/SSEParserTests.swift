import XCTest
@testable import AirlockCompanion

final class SSEParserTests: XCTestCase {

    // MARK: - SSEMessage parsing

    func testParseNewRequestMessage() throws {
        let json = """
        {
            "type": "new",
            "request": {
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "code": "HUMAN-1234",
                "agentId": "agent1",
                "tool": "readFile",
                "context": {
                    "reason": "Need to inspect a config file.",
                    "note": "Read-only request."
                },
                "args": { "path": "/etc/passwd" },
                "timeoutMs": 30000
            }
        }
        """
        let data = json.data(using: .utf8)!
        let message = SSEMessage.parse(from: data)

        guard case .newRequest(let request) = message else {
            XCTFail("Expected newRequest, got \(String(describing: message))")
            return
        }

        XCTAssertEqual(request.id, "550e8400-e29b-41d4-a716-446655440000")
        XCTAssertEqual(request.code, "HUMAN-1234")
        XCTAssertEqual(request.agentId, "agent1")
        XCTAssertEqual(request.tool, "readFile")
        XCTAssertEqual(request.timeoutMs, 30000)
        XCTAssertEqual(request.approvalReason, "Need to inspect a config file.")
        XCTAssertEqual(request.approvalNote, "Read-only request.")
        XCTAssertEqual(request.args["path"], .string("/etc/passwd"))
    }

    func testParseResolvedMessage() throws {
        let json = """
        { "type": "resolved", "code": "HUMAN-1234", "action": "approved" }
        """
        let data = json.data(using: .utf8)!
        let message = SSEMessage.parse(from: data)

        guard case .resolved(let code, let action) = message else {
            XCTFail("Expected resolved, got \(String(describing: message))")
            return
        }

        XCTAssertEqual(code, "HUMAN-1234")
        XCTAssertEqual(action, "approved")
    }

    func testParseDeniedMessage() throws {
        let json = """
        { "type": "resolved", "code": "HUMAN-5678", "action": "denied" }
        """
        let data = json.data(using: .utf8)!
        let message = SSEMessage.parse(from: data)

        guard case .resolved(let code, let action) = message else {
            XCTFail("Expected resolved, got \(String(describing: message))")
            return
        }

        XCTAssertEqual(code, "HUMAN-5678")
        XCTAssertEqual(action, "denied")
    }

    func testParseUnknownTypeReturnsNil() {
        let json = """
        { "type": "unknown", "data": {} }
        """
        let data = json.data(using: .utf8)!
        let message = SSEMessage.parse(from: data)
        XCTAssertNil(message)
    }

    func testParseInvalidJSONReturnsNil() {
        let data = "not json".data(using: .utf8)!
        let message = SSEMessage.parse(from: data)
        XCTAssertNil(message)
    }

    func testParseMissingFieldsReturnsNil() {
        let json = """
        { "type": "new", "request": { "id": "123" } }
        """
        let data = json.data(using: .utf8)!
        let message = SSEMessage.parse(from: data)
        XCTAssertNil(message)
    }

    // MARK: - JSONValue

    func testJSONValueDecodesString() throws {
        let json = "\"hello\""
        let data = json.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(value, .string("hello"))
    }

    func testJSONValueDecodesNumber() throws {
        let json = "42.5"
        let data = json.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(value, .number(42.5))
    }

    func testJSONValueDecodesBool() throws {
        let json = "true"
        let data = json.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(value, .bool(true))
    }

    func testJSONValueDecodesNull() throws {
        let json = "null"
        let data = json.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(value, .null)
    }

    func testJSONValueDecodesArray() throws {
        let json = "[1, \"two\", true]"
        let data = json.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(value, .array([.number(1), .string("two"), .bool(true)]))
    }

    func testJSONValueDecodesNestedObject() throws {
        let json = """
        { "name": "test", "count": 3, "nested": { "key": "value" } }
        """
        let data = json.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: data)

        guard case .object(let dict) = value else {
            XCTFail("Expected object")
            return
        }

        XCTAssertEqual(dict["name"], .string("test"))
        XCTAssertEqual(dict["count"], .number(3))
        XCTAssertEqual(dict["nested"], .object(["key": .string("value")]))
    }

    func testJSONValueRoundTrip() throws {
        let original: JSONValue = .object([
            "string": .string("hello"),
            "number": .number(42),
            "bool": .bool(false),
            "null": .null,
            "array": .array([.number(1), .number(2)]),
            "nested": .object(["key": .string("val")])
        ])

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: encoded)
        XCTAssertEqual(original, decoded)
    }

    // MARK: - ApprovalRequest

    func testApprovalRequestDeadline() {
        let request = ApprovalRequest(
            id: "test",
            code: "CODE-1",
            agentId: "agent",
            tool: "tool",
            args: [:],
            timeoutMs: 30000,
            receivedAt: Date(timeIntervalSince1970: 1000)
        )

        XCTAssertEqual(
            request.deadline.timeIntervalSince1970,
            1030,
            accuracy: 0.001
        )
    }

    func testApprovalRequestArgsDisplay() {
        let request = ApprovalRequest(
            id: "test",
            code: "CODE-1",
            agentId: "agent",
            tool: "tool",
            args: ["path": .string("/tmp/file"), "force": .bool(true)],
            timeoutMs: 30000
        )

        let display = request.argsDisplayString
        XCTAssert(display.contains("force: true"))
        XCTAssert(display.contains("path: \"/tmp/file\""))
    }

    // MARK: - JSONValue display

    func testJSONValueDisplayString() {
        XCTAssertEqual(JSONValue.string("hi").displayString, "\"hi\"")
        XCTAssertEqual(JSONValue.number(42).displayString, "42")
        XCTAssertEqual(JSONValue.number(3.14).displayString, "3.14")
        XCTAssertEqual(JSONValue.bool(true).displayString, "true")
        XCTAssertEqual(JSONValue.null.displayString, "null")
    }
}
