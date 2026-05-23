import AppKit
import SwiftUI

// NSTextView subclass that never accepts first-responder so it never steals
// keyboard focus from the popover's key-handling views.
private final class NonFocusableTextView: NSTextView {
    override var acceptsFirstResponder: Bool { false }
}

struct CodeBlockView: NSViewRepresentable {
    let attributedText: NSAttributedString
    var showsScrollers: Bool = true

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = showsScrollers
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .noBorder

        let textView = NonFocusableTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 10, height: 10)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textStorage?.setAttributedString(attributedText)

        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        nsView.hasVerticalScroller = showsScrollers
        guard let textView = nsView.documentView as? NSTextView else { return }
        if textView.attributedString().isEqual(to: attributedText) {
            return
        }
        textView.textStorage?.setAttributedString(attributedText)
    }
}
