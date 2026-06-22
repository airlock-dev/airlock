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

    private var argsPreview: String {
        CodeHighlighter.argsPreviewString(for: request.args)
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

                if request.timeoutMs > 0 {
                    CountdownTimerView(
                        deadline: request.deadline,
                        totalDuration: TimeInterval(request.timeoutMs) / 1000.0
                    )
                } else {
                    Text("No timeout")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(Color(nsColor: .controlBackgroundColor))
                        .clipShape(Capsule())
                }
            }

            // Args section - keep cards cheap; rich highlighting lives in detail.
            if !request.args.isEmpty {
                let preview = argsPreview
                let lineCount = preview.components(separatedBy: "\n").count

                VStack(alignment: .leading, spacing: 4) {
                    Text(preview)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(isEffectivelyExpanded ? 12 : 3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)

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
