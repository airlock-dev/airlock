import SwiftUI
import UIKit

struct QueueView: View {
    @ObservedObject var viewModel: AppViewModel

    var body: some View {
        List {
            if !viewModel.activePending.isEmpty {
                Section {
                    ForEach(viewModel.activePending) { approval in
                        NavigationLink {
                            QueueApprovalDetailView(
                                viewModel: viewModel,
                                approvalId: approval.id
                            )
                        } label: {
                            ApprovalRow(approval: approval, isPending: true)
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                viewModel.approve(approval)
                            } label: {
                                Label(approval.approveLabel, systemImage: "checkmark")
                            }
                            .tint(.green)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                viewModel.deny(approval)
                            } label: {
                                Label("Deny", systemImage: "xmark")
                            }
                            .tint(.red)
                        }
                    }
                } header: {
                    StatusHeader(viewModel: viewModel)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if viewModel.activePending.isEmpty {
                ContentUnavailableView(
                    "No Pending Approvals",
                    systemImage: "lock.shield",
                    description: Text(viewModel.isRegistered ? "Airlock is quiet." : "Register this iPhone in Settings.")
                )
            }
        }
        .refreshable {
            await viewModel.refreshNow()
        }
        .navigationTitle("Airlock")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct QueueApprovalDetailView: View {
    @ObservedObject var viewModel: AppViewModel
    @State var approvalId: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            if let approval = currentApproval {
                ApprovalDetailView(
                    approval: approval,
                    mode: .pending,
                    decisionBehavior: viewModel.decisionBehavior,
                    hapticsEnabled: viewModel.hapticsEnabled,
                    onApprove: { viewModel.approve(approval) },
                    onDeny: { viewModel.deny(approval) },
                    onAllowOneHour: {
                        viewModel.approve(
                            approval,
                            remember: .temporary,
                            durationMs: 60 * 60 * 1000
                        )
                    },
                    onAlwaysAllow: {
                        viewModel.approve(approval, remember: .always)
                    },
                    onAfterResolve: {
                        advancePast(approval)
                    }
                )
                .id(approval.id)
                .transition(nextApprovalTransition)
            } else {
                ContentUnavailableView("No Pending Approvals", systemImage: "lock.shield")
            }
        }
        .animation(.snappy(duration: 0.24), value: currentApproval?.id)
    }

    private var currentApproval: ApprovalRequest? {
        viewModel.activePending.first { $0.id == approvalId } ?? viewModel.activePending.first
    }

    private var nextApprovalTransition: AnyTransition {
        .asymmetric(
            insertion: .move(edge: .trailing).combined(with: .opacity),
            removal: .move(edge: .leading).combined(with: .opacity)
        )
    }

    private func advancePast(_ approval: ApprovalRequest) {
        guard viewModel.decisionBehavior == .showNext else { return }
        let remaining = viewModel.activePending.filter { $0.id != approval.id }
        if let next = remaining.first {
            withAnimation(.snappy(duration: 0.24)) {
                approvalId = next.id
            }
        } else {
            dismiss()
        }
    }
}

struct HistoryView: View {
    @ObservedObject var viewModel: AppViewModel

    private var recentItems: [RecentItem] {
        let activity = viewModel.activityEvents.map(RecentItem.activity)
        let approvals = viewModel.history.map(RecentItem.approval)
        return (activity + approvals).sorted { $0.date > $1.date }
    }

    var body: some View {
        List {
            if !recentItems.isEmpty {
                Section("Recent") {
                    ForEach(recentItems) { item in
                        switch item {
                        case .activity(let event):
                            ActivityRow(event: event)
                        case .approval(let approval):
                            NavigationLink {
                                ApprovalDetailView(
                                    approval: approval,
                                    mode: .history,
                                    decisionBehavior: viewModel.decisionBehavior,
                                    hapticsEnabled: viewModel.hapticsEnabled,
                                    onApprove: {},
                                    onDeny: {},
                                    onAllowOneHour: {},
                                    onAlwaysAllow: {}
                                )
                                .id(approval.id)
                            } label: {
                                ApprovalRow(approval: approval, isPending: false)
                            }
                        }
                    }
                }
            }
        }
        .overlay {
            if viewModel.history.isEmpty && viewModel.activityEvents.isEmpty {
                ContentUnavailableView("No History", systemImage: "clock")
            }
        }
        .refreshable {
            await viewModel.refreshNow()
        }
        .navigationTitle("Recent")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private enum RecentItem: Identifiable {
    case activity(ActivityEvent)
    case approval(ApprovalRequest)

    var id: String {
        switch self {
        case .activity(let event):
            return "activity-\(event.id)"
        case .approval(let approval):
            return "approval-\(approval.id)"
        }
    }

    var date: Date {
        switch self {
        case .activity(let event):
            return event.createdAt
        case .approval(let approval):
            return approval.resolvedAt ?? approval.createdAt
        }
    }
}

struct SettingsView: View {
    @ObservedObject var viewModel: AppViewModel
    @State private var secretVisible = false

    var body: some View {
        Form {
            Section {
                HStack {
                    Label(connectionStatusTitle, systemImage: connectionStatusIcon)
                    Spacer()
                    if let statusIndicator {
                        Image(systemName: statusIndicator.icon)
                            .foregroundStyle(statusIndicator.color)
                    }
                }
                if let lastError = viewModel.lastError {
                    Text(lastError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }

            Section("Airlock") {
                TextField("https://airlock.example.com", text: $viewModel.baseURLString)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()

                if secretVisible {
                    TextField("API secret", text: $viewModel.adminSecret)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } else {
                    SecureField("API secret", text: $viewModel.adminSecret)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Toggle("Show secret", isOn: $secretVisible)
            }

            Section("Appearance") {
                Picker("Mode", selection: $viewModel.appearance) {
                    ForEach(AppAppearance.allCases) { appearance in
                        Text(appearance.title).tag(appearance.rawValue)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("Detail Actions") {
                Picker("After Approve/Reject", selection: $viewModel.detailDecisionBehavior) {
                    ForEach(DetailDecisionBehavior.allCases) { behavior in
                        Text(behavior.title).tag(behavior.rawValue)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("Notifications While Open") {
                Picker("New Approvals", selection: $viewModel.foregroundNotificationBehavior) {
                    ForEach(ForegroundNotificationBehavior.allCases) { behavior in
                        Text(behavior.title).tag(behavior.rawValue)
                    }
                }
                .pickerStyle(.segmented)

                Toggle("Gentle Haptics", isOn: $viewModel.hapticsEnabled)
            }

            Section("Push") {
                LabeledContent("APNs token") {
                    Text(viewModel.apnsToken.isEmpty ? "Waiting" : "Ready")
                        .foregroundStyle(viewModel.apnsToken.isEmpty ? Color.secondary : Color.green)
                }
                LabeledContent("Device") {
                    Text(viewModel.deviceId.isEmpty ? "Not registered" : viewModel.deviceId)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .font(.footnote.monospaced())
                }

                Button {
                    viewModel.registerCurrentDevice()
                } label: {
                    Label("Register This iPhone", systemImage: "bell.badge")
                }
                .disabled(viewModel.adminSecret.isEmpty || viewModel.baseURLString.isEmpty)

                if viewModel.isRegistered {
                    Button(role: .destructive) {
                        viewModel.forgetCurrentDevice()
                    } label: {
                        Label("Forget This iPhone", systemImage: "iphone.slash")
                    }
                }

                Button {
                    viewModel.sendLocalTestNotification()
                } label: {
                    Label("Send Local Test Notification", systemImage: "bell")
                }
            }

            if !viewModel.lastNotificationActionError.isEmpty || !viewModel.lastPushRegistrationError.isEmpty {
                Section("Push Diagnostics") {
                    if !viewModel.lastNotificationActionError.isEmpty {
                        LabeledContent("Last Action Error") {
                            Text(viewModel.lastNotificationActionError)
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(.red)
                        }
                    }

                    if !viewModel.lastPushRegistrationError.isEmpty {
                        LabeledContent("Registration Error") {
                            Text(viewModel.lastPushRegistrationError)
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(.red)
                        }
                    }

                    Button {
                        viewModel.clearPushDiagnostics()
                    } label: {
                        Label("Clear Diagnostics", systemImage: "xmark.circle")
                    }
                }
            }

            Section("About") {
                LabeledContent("Version") {
                    Text(appVersionString())
                        .foregroundStyle(.secondary)
                }
                Link(destination: URL(string: "https://airlock.bot")!) {
                    Label("airlock.bot", systemImage: "safari")
                }
                Link(destination: URL(string: "https://github.com/airlock-dev/airlock")!) {
                    Label("GitHub", systemImage: "chevron.left.forwardslash.chevron.right")
                }
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var connectionStatusTitle: String {
        if viewModel.connectionMessage == "Connected", !viewModel.isRegistered {
            return "Connected - Push Not Registered"
        }
        return viewModel.connectionMessage
    }

    private var connectionStatusIcon: String {
        switch viewModel.connectionMessage {
        case "Connected", "Registered":
            return viewModel.isRegistered ? "iphone.gen3" : "network"
        case "Offline", "Invalid URL":
            return "wifi.slash"
        case "Registration failed", "Needs registration", "Not registered":
            return "iphone.slash"
        default:
            return "circle"
        }
    }

    private var statusIndicator: (icon: String, color: Color)? {
        switch viewModel.connectionMessage {
        case "Connected", "Registered":
            return viewModel.isRegistered
                ? ("checkmark.circle.fill", .green)
                : ("exclamationmark.circle.fill", .orange)
        case "Offline", "Invalid URL", "Registration failed":
            return ("xmark.circle.fill", .red)
        case "Needs registration", "Not registered":
            return ("exclamationmark.circle.fill", .orange)
        default:
            return nil
        }
    }
}

private func appVersionString() -> String {
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    let build = info?["CFBundleVersion"] as? String ?? "1"
    return "\(version) (\(build))"
}

struct StatusHeader: View {
    @ObservedObject var viewModel: AppViewModel

    var body: some View {
        HStack {
            Label(viewModel.connectionMessage, systemImage: "circle.fill")
                .foregroundStyle(statusColor)
            Spacer()
            Text("\(viewModel.activePendingCount) pending")
                .foregroundStyle(.secondary)
        }
        .font(.footnote.weight(.medium))
    }

    private var statusColor: Color {
        switch viewModel.connectionMessage {
        case "Connected", "Registered":
            return .green
        case "Offline":
            return .red
        default:
            return .orange
        }
    }
}

struct ApprovalRow: View {
    let approval: ApprovalRequest
    let isPending: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(iconBackground)
                    .frame(width: 42, height: 42)
                Image(systemName: iconName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(iconForeground)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(approval.displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                Text(approval.displaySubtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(approval.argsPreview)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text(approval.code)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                RelativeTimeText(date: relativeDate)
            }
        }
        .padding(.vertical, 4)
    }

    private var relativeDate: Date {
        if isPending { return approval.createdAt }
        return approval.resolvedAt ?? approval.createdAt
    }

    private var iconName: String {
        if approval.isUserQuestion { return "questionmark.bubble" }
        if isPending { return "lock.open.trianglebadge.exclamationmark" }
        switch approval.status {
        case "approved":
            return "checkmark"
        case "timeout":
            return "timer"
        default:
            return "xmark"
        }
    }

    private var iconBackground: Color {
        if approval.isUserQuestion { return .blue.opacity(0.16) }
        if isPending { return .orange.opacity(0.18) }
        return approval.status == "approved" ? .green.opacity(0.18) : .red.opacity(0.16)
    }

    private var iconForeground: Color {
        if approval.isUserQuestion { return .blue }
        if isPending { return .orange }
        return approval.status == "approved" ? .green : .red
    }
}

struct ActivityRow: View {
    let event: ActivityEvent

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(iconBackground)
                    .frame(width: 42, height: 42)
                Image(systemName: iconName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(iconForeground)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(event.displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                Text(event.agentId.isEmpty ? event.kind : "\(event.agentId) · \(event.kind)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if !event.displayBody.isEmpty {
                    Text(event.displayBody)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Spacer()

            RelativeTimeText(date: event.createdAt)
        }
        .padding(.vertical, 4)
    }

    private var iconName: String {
        event.kind == "notification" ? "info.circle.fill" : "text.alignleft"
    }

    private var iconBackground: Color {
        event.kind == "notification" ? .blue.opacity(0.16) : .gray.opacity(0.12)
    }

    private var iconForeground: Color {
        event.kind == "notification" ? .blue : .secondary
    }
}

enum ApprovalDetailMode {
    case pending
    case history
}

struct ApprovalDetailView: View {
    let approval: ApprovalRequest
    let mode: ApprovalDetailMode
    let decisionBehavior: DetailDecisionBehavior
    let hapticsEnabled: Bool
    let onApprove: () -> Void
    let onDeny: () -> Void
    let onAllowOneHour: () -> Void
    let onAlwaysAllow: () -> Void
    var onAfterResolve: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var actionFeedback: ApprovalActionFeedback?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(approval.displayTitle)
                        .font(.title2.weight(.semibold))
                    Text(approval.displaySubtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    HStack {
                        Label(approval.code, systemImage: "number")
                        Label(approval.createdAt.formatted(date: .omitted, time: .shortened), systemImage: "clock")
                    }
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                }

                if approval.isUserQuestion, let context = approval.questionContext {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Context")
                            .font(.headline)
                        Text(context)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                if let reason = approval.requestReason {
                    DetailTextBlock(title: "Request reason", value: reason)
                }

                if let note = approval.requestNote {
                    DetailTextBlock(title: "Request note", value: note)
                }

                if let status = approval.status, mode == .history {
                    Label(historyStatusTitle(status), systemImage: historyStatusIcon(status))
                        .foregroundStyle(status == "approved" ? .green : .red)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Arguments")
                        .font(.headline)
                    if approval.args.isEmpty {
                        Text("No arguments")
                            .foregroundStyle(.secondary)
                    } else {
                        Text(approval.argsDisplayString)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }

                if mode == .pending {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let isExpired = approval.isExpired(at: context.date)
                        let isResolved = actionFeedback != nil
                        VStack(spacing: 12) {
                            if let expiresAt = approval.effectiveExpiresAt {
                                if isExpired {
                                    ExpiredApprovalNotice(expiredAt: expiresAt)
                                } else if !isResolved {
                                    TimeoutCountdownView(
                                        createdAt: approval.createdAt,
                                        expiresAt: expiresAt
                                    )
                                }
                            }

                            if let actionFeedback {
                                DecisionFeedbackBanner(feedback: actionFeedback)
                            }

                            if !isExpired && !isResolved {
                                VStack(spacing: 12) {
                                    HStack {
                                        Button {
                                            resolve(.approved, action: onApprove)
                                        } label: {
                                            Label(approval.approveLabel, systemImage: "checkmark")
                                                .frame(maxWidth: .infinity)
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .tint(.green)

                                        Button(role: .destructive) {
                                            resolve(.denied, action: onDeny)
                                        } label: {
                                            Label("Reject", systemImage: "xmark")
                                                .frame(maxWidth: .infinity)
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .tint(.red)
                                    }

                                    if !approval.isUserQuestion {
                                        HStack {
                                            Button {
                                                resolve(.allowOneHour, action: onAllowOneHour)
                                            } label: {
                                                Label("1 Hour", systemImage: "timer")
                                                    .frame(maxWidth: .infinity)
                                            }
                                            .buttonStyle(.bordered)

                                            Button {
                                                resolve(.alwaysAllow, action: onAlwaysAllow)
                                            } label: {
                                                Label("Always", systemImage: "infinity")
                                                    .frame(maxWidth: .infinity)
                                            }
                                            .buttonStyle(.bordered)
                                        }
                                    }
                                }
                                .disabled(actionFeedback != nil)
                                .controlSize(.large)
                                .opacity(actionFeedback == nil ? 1 : 0.55)
                            }
                        }
                    }
                }
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(approval.isUserQuestion ? "Question" : "Approval")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func resolve(_ feedback: ApprovalActionFeedback, action: @escaping () -> Void) {
        guard actionFeedback == nil else { return }
        playDecisionHaptic()
        withAnimation(.snappy(duration: 0.18)) {
            actionFeedback = feedback
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(260))
            action()
            if decisionBehavior == .returnToQueue {
                try? await Task.sleep(for: .milliseconds(120))
                dismiss()
            } else {
                onAfterResolve()
            }
        }
    }

    private func playDecisionHaptic() {
        guard hapticsEnabled else { return }
        UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.55)
    }
}

private struct DetailTextBlock: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            Text(value)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private enum ApprovalActionFeedback {
    case approved
    case denied
    case allowOneHour
    case alwaysAllow

    var title: String {
        switch self {
        case .approved:
            return "Approved"
        case .denied:
            return "Rejected"
        case .allowOneHour:
            return "Allowed for 1 Hour"
        case .alwaysAllow:
            return "Always Allowed"
        }
    }

    var icon: String {
        switch self {
        case .approved, .allowOneHour, .alwaysAllow:
            return "checkmark.circle.fill"
        case .denied:
            return "xmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .approved, .allowOneHour, .alwaysAllow:
            return .green
        case .denied:
            return .red
        }
    }
}

private struct DecisionFeedbackBanner: View {
    let feedback: ApprovalActionFeedback

    var body: some View {
        Label(feedback.title, systemImage: feedback.icon)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(feedback.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(feedback.color.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .transition(.move(edge: .top).combined(with: .opacity))
    }
}

private struct ExpiredApprovalNotice: View {
    let expiredAt: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Expired", systemImage: "timer.circle.fill")
                .font(.subheadline.weight(.semibold))
            Text("This approval timed out \(relativeTimeString(from: expiredAt, to: Date())).")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .foregroundStyle(.red)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.red.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private func historyStatusTitle(_ status: String) -> String {
    status == "timeout" ? "Timed Out" : status.capitalized
}

private func historyStatusIcon(_ status: String) -> String {
    switch status {
    case "approved":
        return "checkmark.circle.fill"
    case "timeout":
        return "timer.circle.fill"
    default:
        return "xmark.circle.fill"
    }
}

private struct RelativeTimeText: View {
    let date: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(relativeTimeString(from: date, to: context.date))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

private func relativeTimeString(from date: Date, to now: Date) -> String {
    if abs(date.timeIntervalSince(now)) < 10 {
        return "Just now"
    }

    let formatter = RelativeDateTimeFormatter()
    formatter.dateTimeStyle = .named
    formatter.unitsStyle = .full
    return formatter.localizedString(for: date, relativeTo: now)
}

struct TimeoutCountdownView: View {
    let createdAt: Date
    let expiresAt: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = max(0, expiresAt.timeIntervalSince(context.date))
            let total = max(1, expiresAt.timeIntervalSince(createdAt))
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Expires in", systemImage: "timer")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text(format(remaining))
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                }
                ProgressView(value: remaining, total: total)
                    .tint(timeoutColor(remaining))
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func timeoutColor(_ remaining: TimeInterval) -> Color {
        remaining < 60 ? .red : .accentColor
    }

    private func format(_ interval: TimeInterval) -> String {
        let seconds = Int(interval.rounded(.down))
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
}
