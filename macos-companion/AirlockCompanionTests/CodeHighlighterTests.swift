import XCTest
@testable import AirlockCompanion

final class CodeHighlighterTests: XCTestCase {
    func testDetectLanguageRecognizesJSONString() {
        XCTAssertEqual(CodeHighlighter.detectLanguage(for: "{\"a\":1}"), .json)
    }

    func testDetectLanguageRecognizesSQLWithComment() {
        XCTAssertEqual(CodeHighlighter.detectLanguage(for: "-- get users\nSELECT * FROM users"), .sql)
    }

    func testFormattedTextPrettyPrintsJSONObject() {
        let value: JSONValue = .object(["b": .number(2), "a": .bool(true)])
        let formatted = CodeHighlighter.formattedText(for: value)

        XCTAssertTrue(formatted.contains("\"a\""))
        XCTAssertTrue(formatted.contains("true"))
        XCTAssertTrue(formatted.contains("\"b\""))
    }

    func testFormattedTextFormatsSQLWithLineBreaks() {
        let value: JSONValue = .string("SELECT * FROM users WHERE active = true")
        let formatted = CodeHighlighter.formattedText(for: value)

        XCTAssertTrue(formatted.contains("\nWHERE"))
    }

    func testFormatSQLPreservesComments() {
        let value: JSONValue = .string("-- get active users\nSELECT * FROM users WHERE active = true")
        let formatted = CodeHighlighter.formattedText(for: value)

        XCTAssertTrue(formatted.contains("-- get active users"))
    }
}
