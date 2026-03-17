import SwiftUI

struct RequestListView: View {
    @ObservedObject var viewModel: AppViewModel
    @Binding var selectedIndex: Int

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(Array(viewModel.pendingRequests.enumerated()), id: \.element.id) { index, request in
                        RequestCardView(
                            request: request,
                            currentTime: viewModel.currentTime,
                            isSelected: index == selectedIndex,
                            onApprove: { viewModel.approve(code: request.code) },
                            onDeny: { viewModel.deny(code: request.code) }
                        )
                        .id(request.id)
                        .transition(.asymmetric(
                            insertion: .move(edge: .top).combined(with: .opacity),
                            removal: .scale.combined(with: .opacity)
                        ))
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .animation(.spring, value: viewModel.pendingRequests.map(\.id))
            .onChange(of: selectedIndex) { _, newIndex in
                guard newIndex < viewModel.pendingRequests.count else { return }
                withAnimation(.easeInOut(duration: 0.15)) {
                    proxy.scrollTo(viewModel.pendingRequests[newIndex].id, anchor: .center)
                }
            }
        }
    }
}
