import SwiftUI

struct RequestCardView: View {
    let request: ApprovalRequest
    let currentTime: Date
    var isSelected: Bool = false
    let onApprove: () -> Void
    let onDeny: () -> Void

    @State private var isExpanded = false
    @State private var acted = false

    private var argsLines: [String] {
        request.argsDisplayString.components(separatedBy: "\n")
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
                    totalDuration: TimeInterval(request.timeoutMs) / 1000.0,
                    currentTime: currentTime
                )
            }

            // Args section
            if !request.args.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    let lines = argsLines
                    let displayLines = isExpanded ? lines : Array(lines.prefix(3))

                    ForEach(Array(displayLines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.primary.opacity(0.8))
                            .lineLimit(1)
                    }

                    if lines.count > 3 {
                        Button(action: { isExpanded.toggle() }) {
                            Text(isExpanded ? "Show less" : "Show more (\(lines.count - 3) more)")
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

            // Action buttons
            HStack(spacing: 8) {
                Button(action: {
                    acted = true
                    onApprove()
                }) {
                    HStack(spacing: 4) {
                        Label("Approve", systemImage: "checkmark.circle.fill")
                        Text("A")
                            .font(.system(size: 9, weight: .medium, design: .rounded))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(.white.opacity(0.2))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    .frame(maxWidth: .infinity)
                }
                .focusable(false)
                .focusEffectDisabled()
                .buttonStyle(.plain)
                .padding(.vertical, 6)
                .background(.green)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 6))

                Button(action: {
                    acted = true
                    onDeny()
                }) {
                    HStack(spacing: 4) {
                        Label("Deny", systemImage: "xmark.circle.fill")
                        Text("D")
                            .font(.system(size: 9, weight: .medium, design: .rounded))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(.white.opacity(0.2))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    .frame(maxWidth: .infinity)
                }
                .focusable(false)
                .focusEffectDisabled()
                .buttonStyle(.plain)
                .padding(.vertical, 6)
                .background(.red)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .font(.system(size: 12, weight: .semibold))
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
