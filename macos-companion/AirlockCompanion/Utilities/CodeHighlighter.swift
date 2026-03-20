import AppKit
import Foundation
import Highlighter

enum CodeHighlighter {
    private static let highlighter: Highlighter? = {
        guard let h = Highlighter() else { return nil }
        // Use a theme that works well on macOS (adapts to dark/light)
        h.setTheme("xcode")
        return h
    }()

    private static let monoFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    static func highlightedString(for value: JSONValue) -> NSAttributedString {
        let text = formattedText(for: value)
        return highlight(text)
    }

    static func highlight(_ text: String) -> NSAttributedString {
        // Let highlight.js auto-detect language and color
        if let h = highlighter, let result = h.highlight(text) {
            let mutable = NSMutableAttributedString(attributedString: result)
            // Ensure monospaced font throughout
            mutable.addAttribute(.font, value: monoFont, range: NSRange(location: 0, length: mutable.length))
            return mutable
        }

        // Fallback: plain monospaced text
        return NSAttributedString(string: text, attributes: [
            .font: monoFont,
            .foregroundColor: NSColor.labelColor
        ])
    }

    static func formattedText(for value: JSONValue) -> String {
        switch value {
        case .string(let string):
            if let normalizedJSON = normalizedJSONString(string) {
                return normalizedJSON
            }
            if looksLikeSQL(string) {
                return formatSQL(string)
            }
            return string
        default:
            return normalizedJSON(value) ?? value.displayString
        }
    }

    // MARK: - Args preview

    static func highlightedArgsPreview(for args: [String: JSONValue], fontSize: CGFloat = 11) -> NSAttributedString {
        let combined = NSMutableAttributedString()
        let sorted = args.sorted(by: { $0.key < $1.key })
        let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)

        for (index, (key, value)) in sorted.enumerated() {
            let formattedValue = formattedText(for: value)
            let isMultiline = formattedValue.contains("\n")

            let keyStr = isMultiline ? "\(key):\n" : "\(key): "
            combined.append(NSAttributedString(string: keyStr, attributes: [
                .font: font,
                .foregroundColor: NSColor.secondaryLabelColor
            ]))

            let displayValue = isMultiline
                ? formattedValue.components(separatedBy: "\n").map { "  " + $0 }.joined(separator: "\n")
                : formattedValue
            let highlighted = highlight(displayValue)
            let mutable = NSMutableAttributedString(attributedString: highlighted)
            mutable.addAttribute(.font, value: font, range: NSRange(location: 0, length: mutable.length))
            combined.append(mutable)

            if index < sorted.count - 1 {
                combined.append(NSAttributedString(string: "\n", attributes: [.font: font]))
            }
        }

        return combined
    }

    // MARK: - SQL Detection & Formatting

    private static let sqlLeaders = ["SELECT ", "INSERT INTO", "INSERT OR", "UPDATE ", "DELETE FROM", "DELETE ", "CREATE TABLE", "CREATE INDEX", "DROP TABLE", "DROP INDEX", "ALTER TABLE", "WITH "]

    private static func looksLikeSQL(_ string: String) -> Bool {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        let upper = trimmed.uppercased()
        if sqlLeaders.contains(where: { upper.hasPrefix($0) }) { return true }

        // Check after stripping leading -- comments
        let firstCodeLine = trimmed.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first(where: { !$0.hasPrefix("--") && !$0.isEmpty })?
            .uppercased()
        if let firstCodeLine, sqlLeaders.contains(where: { firstCodeLine.hasPrefix($0) }) { return true }

        return false
    }

    private static func formatSQL(_ input: String) -> String {
        var segments: [(isComment: Bool, text: String)] = []
        var codeAccumulator = ""

        for line in input.components(separatedBy: .newlines) {
            let stripped = line.trimmingCharacters(in: .whitespaces)
            if stripped.hasPrefix("--") {
                if !codeAccumulator.trimmingCharacters(in: .whitespaces).isEmpty {
                    segments.append((false, codeAccumulator))
                    codeAccumulator = ""
                }
                segments.append((true, stripped))
            } else {
                codeAccumulator += (codeAccumulator.isEmpty ? "" : " ") + stripped
            }
        }
        if !codeAccumulator.trimmingCharacters(in: .whitespaces).isEmpty {
            segments.append((false, codeAccumulator))
        }

        let formatted = segments.map { segment -> String in
            if segment.isComment { return segment.text }
            return formatSQLCode(segment.text)
        }

        return formatted.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func formatSQLCode(_ input: String) -> String {
        let normalized = input
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")

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

    // MARK: - JSON Helpers

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
