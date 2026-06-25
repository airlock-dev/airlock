import SwiftUI

struct RequestListView: View {
    @ObservedObject var viewModel: AppViewModel
    @Binding var selectedIndex: Int
    let onShowDetails: (ApprovalRequest) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(Array(viewModel.pendingRequests.enumerated()), id: \.element.id) { index, request in
                        RequestCardView(
                            request: request,
                            isSelected: index == selectedIndex,
                            autoExpandWhenSelected: viewModel.autoExpandSelectedRequest,
                            onShowDetails: { onShowDetails(request) },
                            onApprove: { viewModel.approve(id: request.id) },
                            onDeny: { viewModel.deny(id: request.id) }
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
