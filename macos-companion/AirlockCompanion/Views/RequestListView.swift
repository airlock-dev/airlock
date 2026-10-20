import SwiftUI

struct RequestListView: View {
    @ObservedObject var viewModel: AppViewModel
    @Binding var selectedIndex: Int
    let onShowDetails: (ApprovalRequest) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    // Bulk controls sit above the list so keyboard selection indexes stay unchanged.
                    ForEach(viewModel.approvalGroups) { group in
                        ApprovalGroupBar(
                            group: group,
                            onApproveAll: { viewModel.approveAll(ids: group.approvableIds) },
                            onDenyAll: { viewModel.denyAll(ids: group.ids) }
                        )
                    }

                    ForEach(Array(viewModel.pendingRequests.enumerated()), id: \.element.id) { index, request in
                        RequestCardView(
                            request: request,
                            isSelected: index == selectedIndex,
                            autoExpandWhenSelected: viewModel.autoExpandSelectedRequest,
                            onShowDetails: { onShowDetails(request) },
                            onApprove: { viewModel.approve(id: request.id) },
                            onDeny: { viewModel.deny(id: request.id) },
                            onApproveWithGrant: { viewModel.approve(id: request.id, grant: $0) }
                        )
                        .id(request.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.trailing, 6)
                .padding(.vertical, 8)
            }
            .scrollIndicators(.hidden)
            .onChange(of: selectedIndex) { _, newIndex in
                guard newIndex < viewModel.pendingRequests.count else { return }
                proxy.scrollTo(viewModel.pendingRequests[newIndex].id, anchor: .center)
            }
        }
    }
}

// MARK: - ApprovalGroupBar

/// "Approve all (N)" / "Deny all" for requests notified together or from the same agent.
struct ApprovalGroupBar: View {
    let group: ApprovalGroup
    let onApproveAll: () -> Void
    let onDenyAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "square.stack.3d.up")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(group.title)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                Text("\(group.requests.count) pending")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Spacer()
            }

            if group.flaggedCount > 0 || group.approvableIds.count < group.requests.count {
                Text(skippedNote)
                    .font(.system(size: 10))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                groupButton(
                    "Approve all (\(group.approvableIds.count))",
                    icon: "checkmark.circle.fill",
                    color: .green,
                    disabled: group.approvableIds.isEmpty,
                    action: onApproveAll
                )
                groupButton(
                    "Deny all (\(group.requests.count))",
                    icon: "xmark.circle.fill",
                    color: .red,
                    disabled: false,
                    action: onDenyAll
                )
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var skippedNote: String {
        let skipped = group.requests.count - group.approvableIds.count
        if group.flaggedCount > 0 && group.flaggedCount == skipped {
            return "\(skipped) flagged — review individually"
        }
        return "\(skipped) need individual review (flagged calls, plans or questions)"
    }

    private func groupButton(
        _ label: String,
        icon: String,
        color: Color,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(label, systemImage: icon)
                .font(.system(size: 11, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
                .background(color.opacity(disabled ? 0.3 : 0.85))
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .focusable(false)
        .focusEffectDisabled()
    }
}
