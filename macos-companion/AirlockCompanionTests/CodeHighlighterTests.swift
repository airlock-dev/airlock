import XCTest
@testable import AirlockCompanion

final class CodeHighlighterTests: XCTestCase {
    func testDetectLanguageRecognizesJSONString() {
        XCTAssertEqual(CodeHighlighter.detectLanguage(for: "{\"a\":1}"), .json)
    }

    func testDetectLanguageRecognizesShellSnippet() {
        XCTAssertEqual(CodeHighlighter.detectLanguage(for: "brew upgrade airlock-companion --greedy"), .shell)
    }

    func testFormattedTextPrettyPrintsJSONObject() {
        let value: JSONValue = .object(["b": .number(2), "a": .bool(true)])
        let formatted = CodeHighlighter.formattedText(for: value)

        XCTAssertTrue(formatted.contains("\"a\""))
        XCTAssertTrue(formatted.contains("true"))
        XCTAssertTrue(formatted.contains("\"b\""))
    }
}
