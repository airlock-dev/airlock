import AppKit
import Foundation

enum CodeLanguage {
    case json
    case shell
    case plainText
}

enum CodeHighlighter {
    static func highlightedString(for value: JSONValue) -> NSAttributedString {
        let text = formattedText(for: value)
        return highlightedString(for: text, language: detectLanguage(for: value))
    }

    static func highlightedString(for text: String, language: CodeLanguage) -> NSAttributedString {
        let string = NSMutableAttributedString(string: text, attributes: baseAttributes)
        let nsRange = NSRange(text.startIndex..., in: text)

        switch language {
        case .json:
            applyJSONHighlighting(to: string, text: text, range: nsRange)
        case .shell:
            applyShellHighlighting(to: string, text: text, range: nsRange)
        case .plainText:
            break
        }

        return string
    }

    static func formattedText(for value: JSONValue) -> String {
        switch value {
        case .string(let string):
            if let normalizedJSON = normalizedJSONString(string) {
                return normalizedJSON
            }
            return string
        default:
            return normalizedJSON(value) ?? value.displayString
        }
    }

    static func detectLanguage(for value: JSONValue) -> CodeLanguage {
        switch value {
        case .object, .array:
            return .json
        case .string(let string):
            if normalizedJSONString(string) != nil {
                return .json
            }
            return detectLanguage(for: string)
        default:
            return .plainText
        }
    }

    static func detectLanguage(for string: String) -> CodeLanguage {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") || trimmed.hasPrefix("[") {
            if normalizedJSONString(trimmed) != nil {
                return .json
            }
        }

        let shellHints = ["--", "|", "&&", "export ", "curl ", "npm ", "brew ", "git ", "npx "]
        if shellHints.contains(where: { trimmed.contains($0) }) {
            return .shell
        }

        return .plainText
    }

    private static let baseAttributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
        .foregroundColor: NSColor.labelColor
    ]

    private static func applyJSONHighlighting(to string: NSMutableAttributedString, text: String, range: NSRange) {
        applyPattern(#""([^"\\]|\\.)*"\s*:"#, color: .systemBlue, to: string, text: text, range: range)
        applyPattern(#""([^"\\]|\\.)*""#, color: .systemGreen, to: string, text: text, range: range)
        applyPattern(#"\b-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\b"#, color: .systemOrange, to: string, text: text, range: range)
        applyPattern(#"\b(?:true|false)\b"#, color: .systemPurple, to: string, text: text, range: range)
        applyPattern(#"\bnull\b"#, color: .systemRed, to: string, text: text, range: range)
    }

    private static func applyShellHighlighting(to string: NSMutableAttributedString, text: String, range: NSRange) {
        applyPattern(#"(^|\s)(--?[A-Za-z0-9_-]+)"#, color: .systemOrange, to: string, text: text, range: range, captureGroup: 2)
        applyPattern(#""([^"\\]|\\.)*""#, color: .systemGreen, to: string, text: text, range: range)
        applyPattern(#"(^|\s)(/[A-Za-z0-9._~\-/]+)"#, color: .systemCyan, to: string, text: text, range: range, captureGroup: 2)
        applyPattern(#"#.*$"#, color: .secondaryLabelColor, to: string, text: text, range: range, options: [.anchorsMatchLines])
    }

    private static func applyPattern(
        _ pattern: String,
        color: NSColor,
        to string: NSMutableAttributedString,
        text: String,
        range: NSRange,
        options: NSRegularExpression.Options = [],
        captureGroup: Int? = nil
    ) {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return
        }

        regex.enumerateMatches(in: text, options: [], range: range) { match, _, _ in
            guard let match else { return }
            let matchRange: NSRange
            if let captureGroup {
                matchRange = match.range(at: captureGroup)
            } else {
                matchRange = match.range
            }
            guard matchRange.location != NSNotFound else { return }
            string.addAttribute(.foregroundColor, value: color, range: matchRange)
        }
    }

    private static func normalizedJSON(_ value: JSONValue) -> String? {
        guard let data = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: data),
              JSONSerialization.isValidJSONObject(object),
              let prettyData = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: prettyData, encoding: .utf8) else {
            return nil
        }

        return string
    }

    private static func normalizedJSONString(_ string: String) -> String? {
        guard let data = string.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              JSONSerialization.isValidJSONObject(object),
              let prettyData = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let prettyString = String(data: prettyData, encoding: .utf8) else {
            return nil
        }

        return prettyString
    }
}
