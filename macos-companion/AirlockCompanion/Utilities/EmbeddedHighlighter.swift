//
//  EmbeddedHighlighter.swift
//  AirlockCompanion
//
//  Self-contained syntax highlighter using embedded highlight.js.
//  No Bundle.module or resource bundles required.
//
//  Based on HighlighterSwift by Juan-Pablo Illanes (Copyright 2016) and
//  Tony Smith (Copyright 2026). Original licence: MIT.
//
//  highlight.js is Copyright (c) 2006-2025 Josh Goebel and contributors (BSD-3-Clause).
//

import AppKit
import JavaScriptCore

// MARK: - EmbeddedHighlighter

/// A lightweight, self-contained syntax highlighter that embeds highlight.js
/// directly as a Swift string literal. Uses JavaScriptCore to run highlight.js
/// and converts the resulting HTML to an `NSAttributedString` using the xcode theme.
///
/// Usage:
/// ```
/// let result = EmbeddedHighlighter.shared.highlight("SELECT * FROM users")
/// ```
final class EmbeddedHighlighter {

    // MARK: - Singleton

    /// Shared instance, initialized on a background thread.
    /// Returns `nil` until initialization completes (callers should fall back to regex).
    static var shared: EmbeddedHighlighter? { _shared }
    private static var _shared: EmbeddedHighlighter?

    /// Kick off background initialization. Call once at app startup.
    static func warmUp() {
        DispatchQueue.global(qos: .userInitiated).async {
            let instance = EmbeddedHighlighter()
            DispatchQueue.main.async { _shared = instance }
        }
    }

    // MARK: - Private Properties

    private let hljs: JSValue
    private let lightTheme: EmbeddedTheme
    private let darkTheme: EmbeddedTheme

    private var theme: EmbeddedTheme {
        let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return isDark ? darkTheme : lightTheme
    }

    private let htmlStart: String = "<"
    private let spanStart: String = "span class=\""
    private let spanStartClose: String = "\">"
    private let spanEnd: String = "/span>"
    private let htmlEscape: NSRegularExpression

    // MARK: - Initializer

    private init?() {
        // Compile the HTML escape regex
        guard let regex = try? NSRegularExpression(pattern: "&#?[a-zA-Z0-9]+?;", options: .caseInsensitive) else {
            return nil
        }
        self.htmlEscape = regex

        // Create a JS context and evaluate highlight.min.js
        guard let context = JSContext() else { return nil }

        // Suppress JS exceptions silently
        context.exceptionHandler = { _, _ in }

        context.evaluateScript(HighlightJSData.highlightJS)

        guard let hljsValue = context.globalObject.objectForKeyedSubscript("hljs"),
              !hljsValue.isUndefined else {
            return nil
        }

        self.hljs = hljsValue
        self.lightTheme = EmbeddedTheme(css: HighlightJSData.xcodeLightCSS)
        self.darkTheme = EmbeddedTheme(css: HighlightJSData.xcodeDarkCSS)
    }

    // MARK: - Public API

    /// Highlight code with automatic language detection.
    ///
    /// - Parameter code: The source code string.
    /// - Returns: A syntax-highlighted `NSAttributedString`, or `nil` on failure.
    func highlight(_ code: String) -> NSAttributedString? {
        guard let returnValue = hljs.invokeMethod("highlightAuto", withArguments: [code]) else {
            return nil
        }

        guard let renderedValue = returnValue.objectForKeyedSubscript("value"),
              let renderedHTML = renderedValue.toString(),
              renderedHTML != "undefined" else {
            return nil
        }

        return processHTMLString(renderedHTML)
    }

    /// Highlight code in a specific language.
    ///
    /// - Parameters:
    ///   - code: The source code string.
    ///   - language: The language identifier (e.g. "json", "sql", "python").
    /// - Returns: A syntax-highlighted `NSAttributedString`, or `nil` on failure.
    func highlight(_ code: String, as language: String) -> NSAttributedString? {
        let options: [String: Any] = ["language": language, "ignoreIllegals": true]
        guard let returnValue = hljs.invokeMethod("highlight", withArguments: [code, options]) else {
            return nil
        }

        guard let renderedValue = returnValue.objectForKeyedSubscript("value"),
              let renderedHTML = renderedValue.toString(),
              renderedHTML != "undefined" else {
            return nil
        }

        return processHTMLString(renderedHTML)
    }

    // MARK: - HTML to NSAttributedString Conversion

    /// Convert the HTML output from highlight.js into an `NSAttributedString`,
    /// applying the theme's colours and font styling.
    private func processHTMLString(_ htmlString: String) -> NSAttributedString? {
        let resultString = NSMutableAttributedString(string: "")
        var scanned: String? = nil
        var propStack: [String] = ["hljs"]
        let scanner = Scanner(string: htmlString)
        scanner.charactersToBeSkipped = nil

        while !scanner.isAtEnd {
            scanned = scanner.scanUpToString(self.htmlStart)

            if let content = scanned, !content.isEmpty {
                resultString.append(self.theme.applyStyle(to: content, styleList: propStack))

                if scanner.isAtEnd {
                    continue
                }
            }

            // Skip over '<'
            guard !scanner.isAtEnd else { break }
            scanner.currentIndex = scanner.string.index(after: scanner.currentIndex)

            guard !scanner.isAtEnd else { break }
            let nextChar = String(scanner.string[scanner.currentIndex])

            if nextChar == "s" {
                // <span class="...">
                _ = scanner.scanString(self.spanStart)
                scanned = scanner.scanUpToString(self.spanStartClose)
                _ = scanner.scanString(self.spanStartClose)

                if let content = scanned, !content.isEmpty {
                    propStack.append(content)
                }
            } else if nextChar == "/" {
                // </span>
                _ = scanner.scanString(self.spanEnd)
                if !propStack.isEmpty {
                    propStack.removeLast()
                }
            } else {
                // Plain '<' character in the code
                let styledChar = self.theme.applyStyle(to: "<", styleList: propStack)
                resultString.append(styledChar)
                if !scanner.isAtEnd {
                    scanner.currentIndex = scanner.string.index(after: scanner.currentIndex)
                }
            }
        }

        // Process HTML character entities (e.g. &amp; &lt; &#64;)
        let results = self.htmlEscape.matches(
            in: resultString.string,
            options: [.reportCompletion],
            range: NSMakeRange(0, resultString.length)
        )

        var localOffset = 0
        for result in results {
            let fixedRange = NSMakeRange(result.range.location - localOffset, result.range.length)
            let entity = (resultString.string as NSString).substring(with: fixedRange)
            if let decoded = HTMLEntityDecoder.decode(entity) {
                resultString.replaceCharacters(in: fixedRange, with: String(decoded))
                localOffset += result.range.length - 1
            }
        }

        return resultString
    }
}

// MARK: - EmbeddedTheme

/// Parses a highlight.js CSS theme string and applies styles as `NSAttributedString` attributes.
private final class EmbeddedTheme {

    let codeFont: NSFont
    let boldCodeFont: NSFont
    let italicCodeFont: NSFont
    let backgroundColour: NSColor

    private typealias ThemeDict = [String: [NSAttributedString.Key: Any]]
    private var themeDict: ThemeDict

    init(css: String, font: NSFont? = nil) {
        let baseFont = font ?? NSFont(name: "Menlo", size: 14.0) ?? NSFont.monospacedSystemFont(ofSize: 14.0, weight: .regular)
        self.codeFont = baseFont

        // Generate bold variant
        let boldDesc = NSFontDescriptor(fontAttributes: [.family: baseFont.familyName!, .face: "Bold"])
        self.boldCodeFont = NSFont(descriptor: boldDesc, size: baseFont.pointSize) ?? baseFont

        // Generate italic variant
        let italicDesc = NSFontDescriptor(fontAttributes: [.family: baseFont.familyName!, .face: "Italic"])
        var italic = NSFont(descriptor: italicDesc, size: baseFont.pointSize)
        if italic == nil || italic!.familyName != baseFont.familyName {
            let obliqueDesc = NSFontDescriptor(fontAttributes: [.family: baseFont.familyName!, .face: "Oblique"])
            italic = NSFont(descriptor: obliqueDesc, size: baseFont.pointSize)
        }
        self.italicCodeFont = italic ?? baseFont

        // Parse the CSS into a style dictionary
        let stripped = EmbeddedTheme.stripCSS(css)
        self.themeDict = EmbeddedTheme.buildThemeDict(from: stripped, codeFont: self.codeFont, boldFont: self.boldCodeFont, italicFont: self.italicCodeFont)

        // Extract background colour
        if let bgHex = stripped[".hljs"]?["background"] ?? stripped[".hljs"]?["background-color"] {
            self.backgroundColour = EmbeddedTheme.colour(from: bgHex)
        } else {
            self.backgroundColour = .white
        }
    }

    /// Apply the theme style to a text string based on the current span class stack.
    func applyStyle(to string: String, styleList: [String]) -> NSAttributedString {
        var attrs: [NSAttributedString.Key: Any] = [
            .font: self.codeFont
        ]

        for style in styleList {
            if let themeStyle = self.themeDict[style] {
                for (key, value) in themeStyle {
                    attrs[key] = value
                }
            }
        }

        return NSAttributedString(string: string, attributes: attrs)
    }

    // MARK: - CSS Parsing

    private static func stripCSS(_ css: String) -> [String: [String: String]] {
        let objcString = css as NSString
        guard let cssRegex = try? NSRegularExpression(
            pattern: "(?:(\\.[a-zA-Z0-9\\-_]*(?:[, ]\\.[a-zA-Z0-9\\-_]*)*)\\{([^\\}]*?)\\})",
            options: [.caseInsensitive]
        ) else {
            return [:]
        }

        let results = cssRegex.matches(in: css, options: [.reportCompletion], range: NSMakeRange(0, objcString.length))
        var resultDict = [String: [String: String]]()

        for result in results {
            guard result.numberOfRanges == 3 else { continue }
            var attributes = [String: String]()
            let cssPairs = objcString.substring(with: result.range(at: 2)).components(separatedBy: ";")
            for pair in cssPairs {
                let components = pair.components(separatedBy: ":")
                if components.count == 2 {
                    attributes[components[0].trimmingCharacters(in: .whitespaces)] =
                        components[1].trimmingCharacters(in: .whitespaces)
                }
            }

            if !attributes.isEmpty {
                let selectorGroup = objcString.substring(with: result.range(at: 1))
                if var existing = resultDict[selectorGroup] {
                    existing.merge(attributes) { first, _ in first }
                    resultDict[selectorGroup] = existing
                } else {
                    resultDict[selectorGroup] = attributes
                }
            }
        }

        // Expand comma/space-separated selectors into individual keys
        var expanded = [String: [String: String]]()
        for (keys, props) in resultDict {
            let keyArray = keys.replacingOccurrences(of: " ", with: ",").components(separatedBy: ",")
            for key in keyArray {
                var current = expanded[key] ?? [:]
                for (name, value) in props {
                    current[name] = value
                }
                expanded[key] = current
            }
        }

        return expanded
    }

    private static func buildThemeDict(
        from stripped: [String: [String: String]],
        codeFont: NSFont,
        boldFont: NSFont,
        italicFont: NSFont
    ) -> ThemeDict {
        var theme = ThemeDict()
        for (className, props) in stripped {
            var keyProps = [NSAttributedString.Key: Any]()
            for (key, value) in props {
                switch key {
                case "color":
                    keyProps[.foregroundColor] = colour(from: value)
                case "background-color":
                    keyProps[.backgroundColor] = colour(from: value)
                case "font-weight":
                    keyProps[.font] = fontForCSS(value, bold: boldFont, italic: italicFont, regular: codeFont)
                case "font-style":
                    keyProps[.font] = fontForCSS(value, bold: boldFont, italic: italicFont, regular: codeFont)
                default:
                    break
                }
            }

            if !keyProps.isEmpty {
                let key = className.replacingOccurrences(of: ".", with: "")
                theme[key] = keyProps
            }
        }
        return theme
    }

    private static func fontForCSS(_ value: String, bold: NSFont, italic: NSFont, regular: NSFont) -> NSFont {
        switch value.trimmingCharacters(in: .whitespaces) {
        case "bold", "bolder", "600", "700", "800", "900":
            return bold
        case "italic", "oblique":
            return italic
        default:
            return regular
        }
    }

    // MARK: - Colour Parsing

    static func colour(from value: String) -> NSColor {
        var hex = value.trimmingCharacters(in: .whitespacesAndNewlines)

        if hex.hasPrefix("#") {
            hex = String(hex.dropFirst())
        } else {
            // Named CSS colours
            switch hex.lowercased() {
            case "white":   return NSColor(white: 1.0, alpha: 1.0)
            case "black":   return NSColor(white: 0.0, alpha: 1.0)
            case "red":     return NSColor(red: 1.0, green: 0.0, blue: 0.0, alpha: 1.0)
            case "green":   return NSColor(red: 0.0, green: 0.5, blue: 0.0, alpha: 1.0)
            case "blue":    return NSColor(red: 0.0, green: 0.0, blue: 1.0, alpha: 1.0)
            case "navy":    return NSColor(red: 0.0, green: 0.0, blue: 0.5, alpha: 1.0)
            case "silver":  return NSColor(red: 0.75, green: 0.75, blue: 0.75, alpha: 1.0)
            default:        return NSColor.gray
            }
        }

        guard hex.count == 3 || hex.count == 6 || hex.count == 8 else {
            return NSColor.gray
        }

        var r: UInt64 = 0, g: UInt64 = 0, b: UInt64 = 0, a: UInt64 = 0
        let divisor: CGFloat
        var alpha: CGFloat = 1.0

        if hex.count == 3 {
            let ns = hex as NSString
            Scanner(string: ns.substring(to: 1)).scanHexInt64(&r)
            Scanner(string: (ns.substring(from: 1) as NSString).substring(to: 1)).scanHexInt64(&g)
            Scanner(string: (ns.substring(from: 2) as NSString).substring(to: 1)).scanHexInt64(&b)
            divisor = 15.0
        } else {
            let ns = hex as NSString
            Scanner(string: ns.substring(to: 2)).scanHexInt64(&r)
            Scanner(string: (ns.substring(from: 2) as NSString).substring(to: 2)).scanHexInt64(&g)
            Scanner(string: (ns.substring(from: 4) as NSString).substring(to: 2)).scanHexInt64(&b)
            divisor = 255.0

            if hex.count == 8 {
                Scanner(string: (ns.substring(from: 6) as NSString).substring(to: 2)).scanHexInt64(&a)
                alpha = CGFloat(a) / divisor
            }
        }

        return NSColor(red: CGFloat(r) / divisor, green: CGFloat(g) / divisor, blue: CGFloat(b) / divisor, alpha: alpha)
    }
}

// MARK: - HTMLEntityDecoder

/// Decodes HTML character entities (e.g. `&amp;`, `&#64;`, `&#x20ac;`) to Swift `Character` values.
private enum HTMLEntityDecoder {

    static func decode(_ entity: String) -> Character? {
        if entity.lowercased().hasPrefix("&#x") {
            return decodeNumeric(String(entity[entity.index(entity.startIndex, offsetBy: 3)...]), base: 16)
        } else if entity.hasPrefix("&#") {
            return decodeNumeric(String(entity[entity.index(entity.startIndex, offsetBy: 2)...]), base: 10)
        } else {
            return characterEntities[entity]
        }
    }

    private static func decodeNumeric(_ value: String, base: Int32) -> Character? {
        let code = UInt32(strtoul(value, nil, base))
        guard let scalar = Unicode.Scalar(code) else { return nil }
        return Character(scalar)
    }

    // swiftlint:disable colon
    private static let characterEntities: [String: Character] = [
        // XML predefined entities
        "&quot;"     : "\"",
        "&amp;"      : "&",
        "&apos;"     : "'",
        "&lt;"       : "<",
        "&gt;"       : ">",

        // Common HTML entities
        "&nbsp;"     : "\u{00A0}",
        "&iexcl;"    : "\u{00A1}",
        "&cent;"     : "\u{00A2}",
        "&pound;"    : "\u{00A3}",
        "&curren;"   : "\u{00A4}",
        "&yen;"      : "\u{00A5}",
        "&brvbar;"   : "\u{00A6}",
        "&sect;"     : "\u{00A7}",
        "&uml;"      : "\u{00A8}",
        "&copy;"     : "\u{00A9}",
        "&ordf;"     : "\u{00AA}",
        "&laquo;"    : "\u{00AB}",
        "&not;"      : "\u{00AC}",
        "&shy;"      : "\u{00AD}",
        "&reg;"      : "\u{00AE}",
        "&macr;"     : "\u{00AF}",
        "&deg;"      : "\u{00B0}",
        "&plusmn;"   : "\u{00B1}",
        "&sup2;"     : "\u{00B2}",
        "&sup3;"     : "\u{00B3}",
        "&acute;"    : "\u{00B4}",
        "&micro;"    : "\u{00B5}",
        "&para;"     : "\u{00B6}",
        "&middot;"   : "\u{00B7}",
        "&cedil;"    : "\u{00B8}",
        "&sup1;"     : "\u{00B9}",
        "&ordm;"     : "\u{00BA}",
        "&raquo;"    : "\u{00BB}",
        "&frac14;"   : "\u{00BC}",
        "&frac12;"   : "\u{00BD}",
        "&frac34;"   : "\u{00BE}",
        "&iquest;"   : "\u{00BF}",
        "&Agrave;"   : "\u{00C0}",
        "&Aacute;"   : "\u{00C1}",
        "&Acirc;"    : "\u{00C2}",
        "&Atilde;"   : "\u{00C3}",
        "&Auml;"     : "\u{00C4}",
        "&Aring;"    : "\u{00C5}",
        "&AElig;"    : "\u{00C6}",
        "&Ccedil;"   : "\u{00C7}",
        "&Egrave;"   : "\u{00C8}",
        "&Eacute;"   : "\u{00C9}",
        "&Ecirc;"    : "\u{00CA}",
        "&Euml;"     : "\u{00CB}",
        "&Igrave;"   : "\u{00CC}",
        "&Iacute;"   : "\u{00CD}",
        "&Icirc;"    : "\u{00CE}",
        "&Iuml;"     : "\u{00CF}",
        "&ETH;"      : "\u{00D0}",
        "&Ntilde;"   : "\u{00D1}",
        "&Ograve;"   : "\u{00D2}",
        "&Oacute;"   : "\u{00D3}",
        "&Ocirc;"    : "\u{00D4}",
        "&Otilde;"   : "\u{00D5}",
        "&Ouml;"     : "\u{00D6}",
        "&times;"    : "\u{00D7}",
        "&Oslash;"   : "\u{00D8}",
        "&Ugrave;"   : "\u{00D9}",
        "&Uacute;"   : "\u{00DA}",
        "&Ucirc;"    : "\u{00DB}",
        "&Uuml;"     : "\u{00DC}",
        "&Yacute;"   : "\u{00DD}",
        "&THORN;"    : "\u{00DE}",
        "&szlig;"    : "\u{00DF}",
        "&agrave;"   : "\u{00E0}",
        "&aacute;"   : "\u{00E1}",
        "&acirc;"    : "\u{00E2}",
        "&atilde;"   : "\u{00E3}",
        "&auml;"     : "\u{00E4}",
        "&aring;"    : "\u{00E5}",
        "&aelig;"    : "\u{00E6}",
        "&ccedil;"   : "\u{00E7}",
        "&egrave;"   : "\u{00E8}",
        "&eacute;"   : "\u{00E9}",
        "&ecirc;"    : "\u{00EA}",
        "&euml;"     : "\u{00EB}",
        "&igrave;"   : "\u{00EC}",
        "&iacute;"   : "\u{00ED}",
        "&icirc;"    : "\u{00EE}",
        "&iuml;"     : "\u{00EF}",
        "&eth;"      : "\u{00F0}",
        "&ntilde;"   : "\u{00F1}",
        "&ograve;"   : "\u{00F2}",
        "&oacute;"   : "\u{00F3}",
        "&ocirc;"    : "\u{00F4}",
        "&otilde;"   : "\u{00F5}",
        "&ouml;"     : "\u{00F6}",
        "&divide;"   : "\u{00F7}",
        "&oslash;"   : "\u{00F8}",
        "&ugrave;"   : "\u{00F9}",
        "&uacute;"   : "\u{00FA}",
        "&ucirc;"    : "\u{00FB}",
        "&uuml;"     : "\u{00FC}",
        "&yacute;"   : "\u{00FD}",
        "&thorn;"    : "\u{00FE}",
        "&yuml;"     : "\u{00FF}",
        "&OElig;"    : "\u{0152}",
        "&oelig;"    : "\u{0153}",
        "&Scaron;"   : "\u{0160}",
        "&scaron;"   : "\u{0161}",
        "&Yuml;"     : "\u{0178}",
        "&fnof;"     : "\u{0192}",
        "&circ;"     : "\u{02C6}",
        "&tilde;"    : "\u{02DC}",
        "&Alpha;"    : "\u{0391}",
        "&Beta;"     : "\u{0392}",
        "&Gamma;"    : "\u{0393}",
        "&Delta;"    : "\u{0394}",
        "&Epsilon;"  : "\u{0395}",
        "&Zeta;"     : "\u{0396}",
        "&Eta;"      : "\u{0397}",
        "&Theta;"    : "\u{0398}",
        "&Iota;"     : "\u{0399}",
        "&Kappa;"    : "\u{039A}",
        "&Lambda;"   : "\u{039B}",
        "&Mu;"       : "\u{039C}",
        "&Nu;"       : "\u{039D}",
        "&Xi;"       : "\u{039E}",
        "&Omicron;"  : "\u{039F}",
        "&Pi;"       : "\u{03A0}",
        "&Rho;"      : "\u{03A1}",
        "&Sigma;"    : "\u{03A3}",
        "&Tau;"      : "\u{03A4}",
        "&Upsilon;"  : "\u{03A5}",
        "&Phi;"      : "\u{03A6}",
        "&Chi;"      : "\u{03A7}",
        "&Psi;"      : "\u{03A8}",
        "&Omega;"    : "\u{03A9}",
        "&alpha;"    : "\u{03B1}",
        "&beta;"     : "\u{03B2}",
        "&gamma;"    : "\u{03B3}",
        "&delta;"    : "\u{03B4}",
        "&epsilon;"  : "\u{03B5}",
        "&zeta;"     : "\u{03B6}",
        "&eta;"      : "\u{03B7}",
        "&theta;"    : "\u{03B8}",
        "&iota;"     : "\u{03B9}",
        "&kappa;"    : "\u{03BA}",
        "&lambda;"   : "\u{03BB}",
        "&mu;"       : "\u{03BC}",
        "&nu;"       : "\u{03BD}",
        "&xi;"       : "\u{03BE}",
        "&omicron;"  : "\u{03BF}",
        "&pi;"       : "\u{03C0}",
        "&rho;"      : "\u{03C1}",
        "&sigmaf;"   : "\u{03C2}",
        "&sigma;"    : "\u{03C3}",
        "&tau;"      : "\u{03C4}",
        "&upsilon;"  : "\u{03C5}",
        "&phi;"      : "\u{03C6}",
        "&chi;"      : "\u{03C7}",
        "&psi;"      : "\u{03C8}",
        "&omega;"    : "\u{03C9}",
        "&thetasym;" : "\u{03D1}",
        "&upsih;"    : "\u{03D2}",
        "&piv;"      : "\u{03D6}",
        "&ensp;"     : "\u{2002}",
        "&emsp;"     : "\u{2003}",
        "&thinsp;"   : "\u{2009}",
        "&zwnj;"     : "\u{200C}",
        "&zwj;"      : "\u{200D}",
        "&lrm;"      : "\u{200E}",
        "&rlm;"      : "\u{200F}",
        "&ndash;"    : "\u{2013}",
        "&mdash;"    : "\u{2014}",
        "&lsquo;"    : "\u{2018}",
        "&rsquo;"    : "\u{2019}",
        "&sbquo;"    : "\u{201A}",
        "&ldquo;"    : "\u{201C}",
        "&rdquo;"    : "\u{201D}",
        "&bdquo;"    : "\u{201E}",
        "&dagger;"   : "\u{2020}",
        "&Dagger;"   : "\u{2021}",
        "&bull;"     : "\u{2022}",
        "&hellip;"   : "\u{2026}",
        "&permil;"   : "\u{2030}",
        "&prime;"    : "\u{2032}",
        "&Prime;"    : "\u{2033}",
        "&lsaquo;"   : "\u{2039}",
        "&rsaquo;"   : "\u{203A}",
        "&oline;"    : "\u{203E}",
        "&frasl;"    : "\u{2044}",
        "&euro;"     : "\u{20AC}",
        "&image;"    : "\u{2111}",
        "&weierp;"   : "\u{2118}",
        "&real;"     : "\u{211C}",
        "&trade;"    : "\u{2122}",
        "&alefsym;"  : "\u{2135}",
        "&larr;"     : "\u{2190}",
        "&uarr;"     : "\u{2191}",
        "&rarr;"     : "\u{2192}",
        "&darr;"     : "\u{2193}",
        "&harr;"     : "\u{2194}",
        "&crarr;"    : "\u{21B5}",
        "&lArr;"     : "\u{21D0}",
        "&uArr;"     : "\u{21D1}",
        "&rArr;"     : "\u{21D2}",
        "&dArr;"     : "\u{21D3}",
        "&hArr;"     : "\u{21D4}",
        "&forall;"   : "\u{2200}",
        "&part;"     : "\u{2202}",
        "&exist;"    : "\u{2203}",
        "&empty;"    : "\u{2205}",
        "&nabla;"    : "\u{2207}",
        "&isin;"     : "\u{2208}",
        "&notin;"    : "\u{2209}",
        "&ni;"       : "\u{220B}",
        "&prod;"     : "\u{220F}",
        "&sum;"      : "\u{2211}",
        "&minus;"    : "\u{2212}",
        "&lowast;"   : "\u{2217}",
        "&radic;"    : "\u{221A}",
        "&prop;"     : "\u{221D}",
        "&infin;"    : "\u{221E}",
        "&ang;"      : "\u{2220}",
        "&and;"      : "\u{2227}",
        "&or;"       : "\u{2228}",
        "&cap;"      : "\u{2229}",
        "&cup;"      : "\u{222A}",
        "&int;"      : "\u{222B}",
        "&there4;"   : "\u{2234}",
        "&sim;"      : "\u{223C}",
        "&cong;"     : "\u{2245}",
        "&asymp;"    : "\u{2248}",
        "&ne;"       : "\u{2260}",
        "&equiv;"    : "\u{2261}",
        "&le;"       : "\u{2264}",
        "&ge;"       : "\u{2265}",
        "&sub;"      : "\u{2282}",
        "&sup;"      : "\u{2283}",
        "&nsub;"     : "\u{2284}",
        "&sube;"     : "\u{2286}",
        "&supe;"     : "\u{2287}",
        "&oplus;"    : "\u{2295}",
        "&otimes;"   : "\u{2297}",
        "&perp;"     : "\u{22A5}",
        "&sdot;"     : "\u{22C5}",
        "&lceil;"    : "\u{2308}",
        "&rceil;"    : "\u{2309}",
        "&lfloor;"   : "\u{230A}",
        "&rfloor;"   : "\u{230B}",
        "&lang;"     : "\u{2329}",
        "&rang;"     : "\u{232A}",
        "&loz;"      : "\u{25CA}",
        "&spades;"   : "\u{2660}",
        "&clubs;"    : "\u{2663}",
        "&hearts;"   : "\u{2665}",
        "&diams;"    : "\u{2666}",
    ]
    // swiftlint:enable colon
}
