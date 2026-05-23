import AppKit
import SwiftUI

struct RequestCardView: View {
    let request: ApprovalRequest
    var isSelected: Bool = false
    var autoExpandWhenSelected: Bool = false
    let onShowDetails: () -> Void
    let onApprove: () -> Void
    let onDeny: () -> Void

    @State private var isExpanded = false
    @State private var acted = false

    private var argsHighlighted: NSAttributedString {
        CodeHighlighter.highlightedArgsPreview(for: request.args)
    }

    private var isEffectivelyExpanded: Bool {
        isExpanded || (autoExpandWhenSelected && isSelected)
    }

    private var showsExpandToggle: Bool {
        !(autoExpandWhenSelected && isSelected)
    }

    var body: some View {
        if !acted {
            cardContent
        }
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header row: tool name + countdown
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(request.tool)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Color.accentColor)

                    Text(request.agentId)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                CountdownTimerView(
                    deadline: request.deadline,
                    totalDuration: TimeInterval(request.timeoutMs) / 1000.0
                )
            }

            // Args section — syntax-highlighted preview
            if !request.args.isEmpty {
                let highlighted = argsHighlighted
                let lineCount = highlighted.string.components(separatedBy: "\n").count

                VStack(alignment: .leading, spacing: 4) {
                    CodeBlockView(attributedText: highlighted, showsScrollers: false)
                        .frame(height: isEffectivelyExpanded
                               ? min(CGFloat(lineCount) * 15 + 20, 220)
                               : 58)

                    if lineCount > 3 && showsExpandToggle {
                        Button(action: { isExpanded.toggle() }) {
                            Text(isEffectivelyExpanded ? "Show less" : "Show more (\(lineCount - 3) more lines)")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .focusable(false)
                        .focusEffectDisabled()
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            Button(action: onShowDetails) {
                Label("View Details", systemImage: "doc.text.magnifyingglass")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .focusable(false)
            .focusEffectDisabled()

            // Action buttons
            ApproveRejectButtons(
                onApprove: { acted = true; onApprove() },
                onDeny:    { acted = true; onDeny() }
            )
        }
        .padding(12)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(isSelected ? Color.accentColor : Color(nsColor: .separatorColor),
                        lineWidth: isSelected ? 2 : 0.5)
        )
    }
}
