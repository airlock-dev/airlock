import SwiftUI

/// Collapsible list of active approval grants with a revoke button on each row.
struct ActiveGrantsView: View {
    let grants: [ApprovalGrant]
    @Binding var isExpanded: Bool
    let onRevoke: (String) -> Void

    var body: some View {
        // Re-render periodically so "expires in" stays current and lapsed grants drop off.
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let active = grants.filter { !$0.isExpired(at: context.date) }
            if !active.isEmpty {
                content(active, now: context.date)
            }
        }
    }

    private func content(_ active: [ApprovalGrant], now: Date) -> some View {
        VStack(spacing: 0) {
            Button(action: { withAnimation(.spring(duration: 0.25)) { isExpanded.toggle() } }) {
                HStack {
                    Image(systemName: "clock.badge.checkmark")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)

                    Text("Active grants")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)

                    Text("\(active.count)")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .focusEffectDisabled()

            if isExpanded {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(active) { grant in
                            GrantRow(grant: grant, now: now, onRevoke: { onRevoke(grant.id) })
                            if grant.id != active.last?.id {
                                Divider().padding(.leading, 36)
                            }
                        }
                    }
                    .padding(.trailing, 6)
                }
                .scrollIndicators(.hidden)
                .frame(maxHeight: 120)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
}

private struct GrantRow: View {
    let grant: ApprovalGrant
    let now: Date
    let onRevoke: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.shield.fill")
                .foregroundStyle(.green)
                .font(.system(size: 12))

            VStack(alignment: .leading, spacing: 2) {
                Text(grant.displayTitle)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)

                Text("\(grant.agentId) · \(grant.statusText(at: now))")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Button(action: onRevoke) {
                Text("Revoke")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.red.opacity(0.12))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .focusEffectDisabled()
            .help("Revoke this grant; matching calls will ask for approval again")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}
