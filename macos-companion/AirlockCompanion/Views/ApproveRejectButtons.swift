import SwiftUI

struct ApproveRejectButtons: View {
    let onApprove: () -> Void
    let onDeny: () -> Void
    var fontSize: CGFloat = 12
    var verticalPadding: CGFloat = 6
    var cornerRadius: CGFloat = 6
    var focusable: Bool = false
    var approveLabel: String = "Approve"
    var denyLabel: String = "Deny"
    /// Server-offered ways to widen this approval into a grant; empty hides the menu.
    var grantOptions: [GrantOption] = []
    var onApproveWithGrant: ((GrantSpec) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            buttonRow
            if !grantOptions.isEmpty, let onApproveWithGrant {
                grantMenu(onApproveWithGrant)
            }
        }
    }

    private var buttonRow: some View {
        HStack(spacing: 8) {
            actionButton(
                label: approveLabel, icon: "checkmark.circle.fill",
                shortcut: "A", color: .green,
                action: onApprove
            )
            actionButton(
                label: denyLabel, icon: "xmark.circle.fill",
                shortcut: "D", color: .red,
                action: onDeny
            )
        }
        .font(.system(size: fontSize, weight: .semibold))
    }

    private func grantMenu(_ approve: @escaping (GrantSpec) -> Void) -> some View {
        Menu {
            ForEach(grantOptions, id: \.self) { option in
                Menu(option.label) {
                    ForEach(GrantDuration.allCases, id: \.self) { duration in
                        Button("For \(duration.label)") {
                            approve(option.spec(durationMs: duration.milliseconds))
                        }
                    }
                }
            }
        } label: {
            Label("Approve & allow…", systemImage: "clock.badge.checkmark")
                .font(.system(size: max(fontSize - 1, 10), weight: .medium))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.visible)
        .fixedSize()
        .focusable(false)
        .focusEffectDisabled()
    }

    private func actionButton(
        label: String,
        icon: String,
        shortcut: String,
        color: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Label(label, systemImage: icon)
                Text(shortcut)
                    .font(.system(size: max(fontSize - 3, 8), weight: .medium, design: .rounded))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(.white.opacity(0.2))
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, verticalPadding)
            .background(color)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius))
        }
        .buttonStyle(.plain)
        .focusable(focusable)
        .focusEffectDisabled(!focusable)
    }
}
