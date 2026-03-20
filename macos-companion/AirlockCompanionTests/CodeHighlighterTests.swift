import XCTest
@testable import AirlockCompanion

final class CodeHighlighterTests: XCTestCase {
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

    func testHighlightReturnsAttributedString() {
        let result = CodeHighlighter.highlight("SELECT 1")
        XCTAssertFalse(result.string.isEmpty)
    }
}
