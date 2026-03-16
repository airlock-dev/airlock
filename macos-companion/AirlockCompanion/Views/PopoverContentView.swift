import SwiftUI

struct PopoverContentView: View {
    @ObservedObject var viewModel: AppViewModel
    @State private var showSettings = false
    @State private var showHistory = false

    private var statusColor: Color {
        switch viewModel.connectionState {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return .red
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)

                Text("Airlock")
                    .font(.system(size: 14, weight: .semibold))

                if viewModel.pendingCount > 0 {
                    Text("\(viewModel.pendingCount)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.red)
                        .clipShape(Capsule())
                }

                Spacer()

                Button(action: { showSettings.toggle() }) {
                    Image(systemName: "gear")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .focusable(false)
                .focusEffectDisabled()
                .popover(isPresented: $showSettings) {
                    SettingsView(viewModel: viewModel)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            Divider()

            // Body
            if viewModel.pendingCount > 0 {
                RequestListView(viewModel: viewModel)
            } else {
                EmptyStateView(connectionState: viewModel.connectionState)
            }

            // History
            if !viewModel.resolvedRequests.isEmpty {
                Divider()
                HistoryView(resolvedRequests: viewModel.resolvedRequests, isExpanded: $showHistory)
            }
        }
        .frame(width: Constants.popoverWidth)
        .frame(maxHeight: Constants.popoverMaxHeight)
    }
}

// MARK: - History

struct HistoryView: View {
    let resolvedRequests: [ResolvedRequest]
    @Binding var isExpanded: Bool

    var body: some View {
        VStack(spacing: 0) {
            Button(action: { withAnimation(.spring(duration: 0.25)) { isExpanded.toggle() } }) {
                HStack {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)

                    Text("History")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)

                    Text("\(resolvedRequests.count)")
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
                        ForEach(resolvedRequests) { resolved in
                            HistoryRow(resolved: resolved)
                            if resolved.id != resolvedRequests.last?.id {
                                Divider().padding(.leading, 36)
                            }
                        }
                    }
                }
                .frame(maxHeight: 200)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
}

struct HistoryRow: View {
    let resolved: ResolvedRequest
    @State private var isExpanded = false

    private var timeAgo: String {
        let interval = Date().timeIntervalSince(resolved.resolvedAt)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        return "\(Int(interval / 3600))h ago"
    }

    private var title: String {
        if !resolved.agentId.isEmpty && !resolved.tool.isEmpty {
            return "\(resolved.agentId): \(resolved.tool)"
        }
        if !resolved.tool.isEmpty { return resolved.tool }
        return resolved.code
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: {
                if !resolved.argsDisplay.isEmpty {
                    withAnimation(.spring(duration: 0.2)) { isExpanded.toggle() }
                }
            }) {
                HStack(spacing: 8) {
                    Image(systemName: resolved.action == "approved"
                          ? "checkmark.circle.fill"
                          : "xmark.circle.fill")
                        .foregroundStyle(resolved.action == "approved" ? .green : .red)
                        .font(.system(size: 12))

                    Text(title)
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)

                    Spacer()

                    Text(timeAgo)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)

                    if !resolved.argsDisplay.isEmpty {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .focusEffectDisabled()

            if isExpanded && !resolved.argsDisplay.isEmpty {
                Text(resolved.argsDisplay)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(5)
                    .padding(.horizontal, 36)
                    .padding(.bottom, 4)
                    .transition(.opacity)
            }
        }
    }
}
