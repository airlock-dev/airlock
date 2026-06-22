import AppKit
import SwiftUI

// MARK: - PopoverContentView

struct PopoverContentView: View {
    @ObservedObject var viewModel: AppViewModel
    let onOpenSettingsRequest: () -> Void
    @Environment(\.openSettings) private var openSettings
    @AppStorage(Constants.UserDefaultsKeys.displayDensity) private var densityString: String = DisplayDensity.compact.rawValue
    @State private var showHistory = false
    @State private var detailRequest: ApprovalRequest?
    @State private var detailArgsScrollView: NSScrollView? = nil
    @FocusState private var isFocused: Bool

    private var density: DisplayDensity { DisplayDensity(rawValue: densityString) ?? .compact }
    private var isDetail: Bool { detailRequest != nil }

    private var statusColor: Color {
        switch viewModel.connectionState {
        case .connected:    return .green
        case .connecting:   return .yellow
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

                Button(action: {
                    onOpenSettingsRequest()
                    openSettings()
                }) {
                    Image(systemName: "gear")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .focusable(false)
                .focusEffectDisabled()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            Divider()

            // Body — list or detail inline
            if let request = detailRequest {
                RequestDetailView(
                    request: request,
                    onApprove: { viewModel.approve(code: request.code) },
                    onDeny:    { viewModel.deny(code: request.code) },
                    onDismiss: { detailRequest = nil },
                    onNext:    adjacentRequest(from: request, by: +1).map { next in
                        { navigate(to: next) }
                    },
                    onPrev:    adjacentRequest(from: request, by: -1).map { prev in
                        { navigate(to: prev) }
                    },
                    argsScrollView: $detailArgsScrollView
                )
            } else {
                if viewModel.pendingCount > 0 {
                    RequestListView(viewModel: viewModel, selectedIndex: $viewModel.selectedIndex) { request in
                        detailRequest = request
                    }
                } else {
                    EmptyStateView(connectionState: viewModel.connectionState)
                }

                // History
                if !viewModel.resolvedRequests.isEmpty {
                    Divider()
                    HistoryView(resolvedRequests: viewModel.resolvedRequests, isExpanded: $showHistory)
                }
            }
        }
        .frame(width: isDetail ? 620 : density.popoverWidth)
        .frame(maxHeight: isDetail ? 520 : density.popoverMaxHeight)
        .focusable()
        .focused($isFocused)
        .focusEffectDisabled()
        .onAppear { isFocused = true }
        .onKeyPress(phases: .down) { press in
            guard !press.modifiers.contains(.command) else { return .ignored }

            let key = press.characters.lowercased()
            let shift = press.modifiers.contains(.shift)

            if let request = detailRequest {
                if !shift {
                    if key == "a"                                          { viewModel.approve(code: request.code); detailRequest = nil }
                    else if key == "d"                                     { viewModel.deny(code: request.code);    detailRequest = nil }
                    else if press.key == .escape || key == "h" || press.key == .leftArrow  { detailRequest = nil }
                    else if key == "j" || press.key == .downArrow          { scrollDetail(80) }
                    else if key == "k" || press.key == .upArrow            { scrollDetail(-80) }
                } else {
                    if key == "j" || press.key == .downArrow {
                        if let next = adjacentRequest(from: request, by: +1) { navigate(to: next) }
                    } else if key == "k" || press.key == .upArrow {
                        if let prev = adjacentRequest(from: request, by: -1) { navigate(to: prev) }
                    }
                }
                return .handled
            }

            let count = viewModel.pendingRequests.count
            if key == "j" || press.key == .downArrow {
                if count > 0 { viewModel.selectedIndex = min(viewModel.selectedIndex + 1, count - 1) }
                return .handled
            }
            if key == "k" || press.key == .upArrow {
                if count > 0 { viewModel.selectedIndex = max(viewModel.selectedIndex - 1, 0) }
                return .handled
            }
            if key == "a" { if count > 0 { viewModel.approveSelectedRequest() }; return .handled }
            if key == "d" { if count > 0 { viewModel.denySelectedRequest()    }; return .handled }
            if key == "l" || press.key == .rightArrow || press.key == .return || press.key == .space {
                if count > 0 { detailRequest = viewModel.pendingRequests[min(viewModel.selectedIndex, count - 1)] }
                return .handled
            }
            return .handled
        }
        .onChange(of: viewModel.pendingRequests.count) { _, newCount in
            if viewModel.selectedIndex >= newCount { viewModel.selectedIndex = max(0, newCount - 1) }
            if let detailRequest,
               !viewModel.pendingRequests.contains(where: { $0.id == detailRequest.id }) {
                self.detailRequest = nil
            }
        }
    }

    private func navigate(to request: ApprovalRequest) {
        detailArgsScrollView = nil
        detailRequest = request
        viewModel.selectedIndex = viewModel.pendingRequests.firstIndex(where: { $0.id == request.id }) ?? viewModel.selectedIndex
    }

    private func scrollDetail(_ delta: CGFloat) {
        guard let sv = detailArgsScrollView else { return }
        let clip = sv.contentView
        let maxY = max(0, (sv.documentView?.bounds.height ?? 0) - clip.bounds.height)
        let newY = max(0, min(clip.bounds.origin.y + delta, maxY))
        clip.scroll(to: NSPoint(x: 0, y: newY))
        sv.reflectScrolledClipView(clip)
    }

    private func adjacentRequest(from request: ApprovalRequest, by delta: Int) -> ApprovalRequest? {
        let requests = viewModel.pendingRequests
        guard let idx = requests.firstIndex(where: { $0.id == request.id }) else { return nil }
        let newIdx = idx + delta
        guard newIdx >= 0 && newIdx < requests.count else { return nil }
        return requests[newIdx]
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
                    .padding(.trailing, 6)
                }
                .scrollIndicators(.hidden)
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
        if !resolved.agentId.isEmpty && !resolved.tool.isEmpty { return "\(resolved.agentId): \(resolved.tool)" }
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
                    Image(systemName: historyIcon)
                        .foregroundStyle(historyTint)
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

    private var historyIcon: String {
        switch resolved.action {
        case "approved":
            return "checkmark.circle.fill"
        case "timeout":
            return "timer.circle.fill"
        default:
            return "xmark.circle.fill"
        }
    }

    private var historyTint: Color {
        resolved.action == "approved" ? .green : .red
    }
}
