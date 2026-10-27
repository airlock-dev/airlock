import SwiftUI

/// Small capsules for flagged / tier / plan / async metadata. Renders nothing for older gateways.
struct RequestBadgesView: View {
    let request: ApprovalRequest

    var body: some View {
        if hasBadges {
            HStack(spacing: 4) {
                if request.escalated {
                    badge("Flagged", icon: "exclamationmark.triangle.fill", color: .orange)
                }
                if let tier = request.tierLabel {
                    badge(tier, icon: nil, color: tierColor)
                }
                if request.isPlan {
                    badge("Plan · \(request.planEntries.count)", icon: "list.bullet", color: .blue)
                }
                if request.mode == "async" {
                    badge("Async", icon: nil, color: .secondary)
                }
            }
        }
    }

    private var hasBadges: Bool {
        request.escalated || request.tierLabel != nil || request.isPlan || request.mode == "async"
    }

    private var tierColor: Color {
        switch request.tier {
        case "read": return .green
        case "write": return .yellow
        case "destructive": return .red
        default: return .secondary
        }
    }

    private func badge(_ text: String, icon: String?, color: Color) -> some View {
        HStack(spacing: 3) {
            if let icon {
                Image(systemName: icon)
            }
            Text(text)
        }
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.15))
        .clipShape(Capsule())
    }
}

/// The calls inside a plan request: one block per call, tool on top, one row per argument.
struct PlanEntriesView: View {
    let entries: [PlanEntry]
    var maxVisible: Int? = nil
    var fontSize: CGFloat = 11

    private var visible: [PlanEntry] {
        guard let maxVisible else { return entries }
        return Array(entries.prefix(maxVisible))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(visible.enumerated()), id: \.offset) { index, entry in
                if index > 0 {
                    Divider()
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(index + 1).")
                        .font(.system(size: fontSize, design: .monospaced))
                        .foregroundStyle(.tertiary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.tool)
                            .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                        if entry.args.isEmpty {
                            Text("No arguments")
                                .font(.system(size: fontSize - 1))
                                .foregroundStyle(.tertiary)
                        }
                        ForEach(entry.argRows, id: \.key) { row in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(row.key)
                                    .foregroundStyle(.tertiary)
                                Text(row.value)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(maxVisible == nil ? 6 : 2)
                                    .truncationMode(.tail)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .font(.system(size: fontSize - 1, design: .monospaced))
                        }
                    }
                }
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if visible.count < entries.count {
                Text("+ \(entries.count - visible.count) more — View Details for all")
                    .font(.system(size: max(fontSize - 1, 9)))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
