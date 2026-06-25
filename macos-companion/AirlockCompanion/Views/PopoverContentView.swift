import AppKit
import SwiftUI

// MARK: - PopoverContentView

struct PopoverContentView: View {
    @ObservedObject var viewModel: AppViewModel
    let onOpenSettingsRequest: () -> Void
    @Environment(\.openSettings) private var openSettings
    @AppStorage(Constants.UserDefaultsKeys.displayDensity) private var densityString: String = DisplayDensity.compact.rawValue
    @State private var showRecent = true
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
                    onApprove: { viewModel.approve(id: request.id) },
                    onDeny:    { viewModel.deny(id: request.id) },
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

                if !viewModel.activityEvents.isEmpty || !viewModel.resolvedRequests.isEmpty {
                    Divider()
                    RecentEventsView(
                        activityEvents: viewModel.activityEvents,
                        resolvedRequests: viewModel.resolvedRequests,
                        isExpanded: $showRecent
                    )
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
                    if key == "a"                                          { viewModel.approve(id: request.id); detailRequest = nil }
                    else if key == "d"                                     { viewModel.deny(id: request.id);    detailRequest = nil }
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

// MARK: - Recent

private enum RecentItem: Identifiable {
    case activity(ActivityEvent)
    case resolved(ResolvedRequest)

    var id: String {
        switch self {
        case .activity(let event):
            return "activity-\(event.id)"
        case .resolved(let request):
            return "resolved-\(request.id)"
        }
    }

    var date: Date {
        switch self {
        case .activity(let event):
            return event.createdDate
        case .resolved(let request):
            return request.resolvedAt
        }
    }
}

private struct RecentEventsView: View {
    let activityEvents: [ActivityEvent]
    let resolvedRequests: [ResolvedRequest]
    @Binding var isExpanded: Bool

    private var items: [RecentItem] {
        let activity = activityEvents.map(RecentItem.activity)
        let resolved = resolvedRequests.map(RecentItem.resolved)
        return (activity + resolved).sorted { $0.date > $1.date }
    }

    var body: some View {
        VStack(spacing: 0) {
            Button(action: { withAnimation(.spring(duration: 0.25)) { isExpanded.toggle() } }) {
                HStack {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)

                    Text("Recent")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)

                    Text("\(items.count)")
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
                        ForEach(items) { item in
                            RecentEventRow(item: item)
                            if item.id != items.last?.id {
                                Divider().padding(.leading, 36)
                            }
                        }
                    }
                    .padding(.trailing, 6)
                }
                .scrollIndicators(.hidden)
                .frame(maxHeight: 160)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
}

private struct RecentEventRow: View {
    let item: RecentItem
    @State private var isExpanded = false

    private var title: String {
        switch item {
        case .activity(let event):
            return event.displayTitle
        case .resolved(let resolved):
            return resolved.displayTitle
        }
    }

    private var detail: String {
        switch item {
        case .activity(let event):
            return event.displayBody
        case .resolved(let resolved):
            return resolved.displayDetail
        }
    }

    private var argsDisplay: String {
        guard case .resolved(let resolved) = item else { return "" }
        return resolved.argsDisplay
    }

    private var trailingLabel: String {
        switch item {
        case .activity(let event):
            return event.kind
        case .resolved(let resolved):
            return timeAgo(since: resolved.resolvedAt)
        }
    }

    private var iconName: String {
        switch item {
        case .activity(let event):
            return event.kind == "notification" ? "info.circle.fill" : "text.alignleft"
        case .resolved(let resolved):
            switch resolved.action {
            case "approved":
                return "checkmark.circle.fill"
            case "timeout":
                return "timer.circle.fill"
            default:
                return "xmark.circle.fill"
            }
        }
    }

    private var iconTint: Color {
        switch item {
        case .activity(let event):
            return event.kind == "notification" ? .blue : .secondary
        case .resolved(let resolved):
            switch resolved.action {
            case "approved":
                return .green
            case "timeout":
                return .orange
            default:
                return .red
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: {
                if !argsDisplay.isEmpty {
                    withAnimation(.spring(duration: 0.2)) { isExpanded.toggle() }
                }
            }) {
                HStack(spacing: 8) {
                    Image(systemName: iconName)
                        .foregroundStyle(iconTint)
                        .font(.system(size: 12))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.system(size: 11, weight: .medium))
                            .lineLimit(1)

                        if !detail.isEmpty {
                            Text(detail)
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }

                    Spacer()

                    Text(trailingLabel)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)

                    if !argsDisplay.isEmpty {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .focusEffectDisabled()

            if isExpanded && !argsDisplay.isEmpty {
                Text(argsDisplay)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(5)
                    .padding(.horizontal, 36)
                    .padding(.bottom, 4)
                    .transition(.opacity)
            }
        }
    }

    private func timeAgo(since date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        return "\(Int(interval / 3600))h ago"
    }
}
