import SwiftUI

struct ApproveRejectButtons: View {
    let onApprove: () -> Void
    let onDeny: () -> Void
    var fontSize: CGFloat = 12
    var verticalPadding: CGFloat = 6
    var cornerRadius: CGFloat = 6
    var focusable: Bool = false

    var body: some View {
        HStack(spacing: 8) {
            actionButton(
                label: "Approve", icon: "checkmark.circle.fill",
                shortcut: "A", color: .green,
                action: onApprove
            )
            actionButton(
                label: "Deny", icon: "xmark.circle.fill",
                shortcut: "D", color: .red,
                action: onDeny
            )
        }
        .font(.system(size: fontSize, weight: .semibold))
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
        }
        .buttonStyle(.plain)
        .focusable(focusable)
        .focusEffectDisabled(!focusable)
        .padding(.vertical, verticalPadding)
        .background(color)
        .foregroundStyle(.white)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }
}
