import AppKit
import Foundation

enum CodeLanguage {
    case json
    case shell
    case sql
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
        case .sql:
            applySQLHighlighting(to: string, text: text, range: nsRange)
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
            if detectLanguage(for: string) == .sql {
                return formatSQL(string)
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

        let upper = trimmed.uppercased()
        let sqlLeaders = ["SELECT ", "INSERT INTO", "INSERT OR", "UPDATE ", "DELETE FROM", "DELETE ", "CREATE TABLE", "CREATE INDEX", "DROP TABLE", "DROP INDEX", "ALTER TABLE", "WITH "]
        if sqlLeaders.contains(where: { upper.hasPrefix($0) }) {
            return .sql
        }

        let shellHints = ["--", "|", "&&", "export ", "curl ", "npm ", "brew ", "git ", "npx "]
        if shellHints.contains(where: { trimmed.contains($0) }) {
            return .shell
        }

        return .plainText
    }

    // MARK: - Args preview

    /// Builds a combined syntax-highlighted attributed string for all args (for use in card previews).
    static func highlightedArgsPreview(for args: [String: JSONValue], fontSize: CGFloat = 11) -> NSAttributedString {
        let combined = NSMutableAttributedString()
        let sorted = args.sorted(by: { $0.key < $1.key })

        for (index, (key, value)) in sorted.enumerated() {
            let formattedValue = formattedText(for: value)
            let language = detectLanguage(for: value)
            let isMultiline = formattedValue.contains("\n")

            let keyStr = isMultiline ? "\(key):\n" : "\(key): "
            combined.append(NSAttributedString(string: keyStr, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular),
                .foregroundColor: NSColor.secondaryLabelColor
            ]))

            let displayValue = isMultiline
                ? formattedValue.components(separatedBy: "\n").map { "  " + $0 }.joined(separator: "\n")
                : formattedValue
            let highlighted = highlightedString(for: displayValue, language: language)
            let mutable = NSMutableAttributedString(attributedString: highlighted)
            mutable.addAttribute(
                .font,
                value: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular),
                range: NSRange(location: 0, length: mutable.length)
            )
            combined.append(mutable)

            if index < sorted.count - 1 {
                combined.append(NSAttributedString(string: "\n", attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
                ]))
            }
        }

        return combined
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

    // MARK: - SQL

    private static func formatSQL(_ input: String) -> String {
        // Normalize whitespace
        let normalized = input
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        // Pattern matches major clause keywords that should start a new line.
        // Uses lookbehind so we don't break SELECT at the very start.
        let pattern = "(?<=\\s)(FROM|WHERE|AND|OR|GROUP\\s+BY|HAVING|ORDER\\s+BY|LIMIT|OFFSET|(?:(?:LEFT|RIGHT|INNER|OUTER|CROSS)\\s+)?JOIN|ON|UNION(?:\\s+ALL)?|EXCEPT|INTERSECT|RETURNING|SET)(?=\\s)"

        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return normalized
        }

        let range = NSRange(normalized.startIndex..., in: normalized)
        let matches = regex.matches(in: normalized, range: range).reversed()
        var result = normalized

        for match in matches {
            guard let swiftRange = Range(match.range, in: result) else { continue }
            let keyword = String(result[swiftRange]).trimmingCharacters(in: .whitespaces)
            result.replaceSubrange(swiftRange, with: "\n" + keyword.uppercased())
        }

        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func applySQLHighlighting(to string: NSMutableAttributedString, text: String, range: NSRange) {
        // DML/DDL/clause keywords
        let keywords = "SELECT|FROM|WHERE|AND|OR|NOT|IN|LIKE|ILIKE|IS|NULL|TRUE|FALSE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|AS|WITH|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|RETURNING|DO|NOTHING|CONFLICT|INDEX|VIEW|SCHEMA|DEFAULT|CONSTRAINT|UNIQUE|CHECK|ASC|DESC|NULLS|FIRST|LAST|OVER|PARTITION|ROWS|RANGE|UNBOUNDED|PRECEDING|FOLLOWING|CURRENT|ROW"
        applyPattern(
            "\\b(\(keywords))\\b",
            color: .systemBlue,
            to: string, text: text, range: range,
            options: [.caseInsensitive]
        )

        // Built-in functions
        let functions = "COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|SUBSTRING|TRIM|UPPER|LOWER|LENGTH|NOW|DATE|EXTRACT|ROUND|FLOOR|CEIL|CEILING|ABS|MOD|CONCAT|ARRAY_AGG|STRING_AGG|JSON_AGG|JSONB_AGG|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|NTILE|PERCENT_RANK|CUME_DIST|FIRST_VALUE|LAST_VALUE|NTH_VALUE"
        applyPattern(
            "\\b(\(functions))(?=\\s*\\()",
            color: .systemPurple,
            to: string, text: text, range: range,
            options: [.caseInsensitive]
        )

        // String literals
        applyPattern("'(?:[^'\\\\]|\\\\.)*'", color: .systemGreen, to: string, text: text, range: range)

        // Numbers
        applyPattern("\\b\\d+(\\.\\d+)?\\b", color: .systemOrange, to: string, text: text, range: range)

        // Line comments
        applyPattern("--.*$", color: .secondaryLabelColor, to: string, text: text, range: range, options: [.anchorsMatchLines])

        // Block comments
        applyPattern("/\\*[\\s\\S]*?\\*/", color: .secondaryLabelColor, to: string, text: text, range: range, options: [.dotMatchesLineSeparators])
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
