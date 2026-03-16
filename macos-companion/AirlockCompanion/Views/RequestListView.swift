import SwiftUI

struct RequestListView: View {
    @ObservedObject var viewModel: AppViewModel

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(viewModel.pendingRequests) { request in
                    RequestCardView(
                        request: request,
                        currentTime: viewModel.currentTime,
                        onApprove: { viewModel.approve(code: request.code) },
                        onDeny: { viewModel.deny(code: request.code) }
                    )
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
    }
}
