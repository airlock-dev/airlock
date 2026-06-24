import AppKit
import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @ObservedObject var viewModel: AppViewModel
    @State private var urlText: String = ""
    @State private var tokenText: String = ""
    @State private var launchAtLogin: Bool = SMAppService.mainApp.status == .enabled
    @State private var testConnectionState: TestConnectionState?

    private let shortcutKeys = (65...90).compactMap { UnicodeScalar($0).map(String.init) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerCard
                preferencesCard
                diagnosticsCard
                shortcutsCard
                updatesCard
            }
            .padding(24)
        }
        .frame(width: 540, height: 520)
        .background(windowBackground)
        .onAppear {
            urlText = viewModel.dashboardURL
            tokenText = viewModel.gatewayToken
        }
        .onChange(of: urlText) { _, _ in
            testConnectionState = nil
        }
        .onChange(of: tokenText) { _, _ in
            testConnectionState = nil
        }
    }

    private var headerCard: some View {
        HStack(spacing: 16) {
            appIcon

            VStack(alignment: .leading, spacing: 6) {
                Text("Airlock Companion")
                    .font(.system(size: 28, weight: .semibold))

                Text("Manage connection, shortcuts, and update status for the Airlock menu bar companion.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    let updateStatus = updateStatusBadge
                    statusBadge(
                        title: updateStatus.title,
                        tint: updateStatus.tint
                    )

                    statusBadge(
                        title: viewModel.appVersion,
                        tint: Color.accentColor.opacity(0.9)
                    )
                }
            }

            Spacer()
        }
        .padding(20)
        .background(
            LinearGradient(
                colors: [
                    Color(nsColor: .controlBackgroundColor),
                    Color.accentColor.opacity(0.10)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .shadow(color: .black.opacity(0.10), radius: 24, y: 10)
    }

    private var preferencesCard: some View {
        settingsCard(title: "General", subtitle: "Connection and notifications") {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Airlock URL")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)

                    TextField(
                        "http://127.0.0.1:4113",
                        text: $urlText
                    )
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 13, design: .monospaced))
                    .onSubmit(applyConnectionSettings)

                    Text("Admin API token")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)

                    SecureField("Paste AIRLOCK_API_SECRET", text: $tokenText)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 13, design: .monospaced))
                    .onSubmit(applyConnectionSettings)

                    HStack(spacing: 10) {
                        connectionIndicator

                        Button(testConnectionState == .testing ? "Testing" : "Test connection") {
                            testConnectionSettings()
                        }
                        .controlSize(.small)
                        .disabled(testConnectionState == .testing)
                    }

                    HStack {
                        Text("Press Return or Apply to save.")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)

                        Spacer()

                        Button("Apply") {
                            applyConnectionSettings()
                        }
                        .controlSize(.small)
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 10) {
                    settingsRowTitle(
                        title: "Display density",
                        detail: "Controls the width of the popover."
                    )

                    Picker("Display density", selection: densityBinding) {
                        ForEach(DisplayDensity.allCases, id: \.rawValue) { density in
                            Text(density.displayName).tag(density.rawValue)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .frame(maxWidth: .infinity)
                }

                Divider()

                HStack(alignment: .center, spacing: 16) {
                    settingsRowTitle(
                        title: "Notification sounds",
                        detail: "Play an alert sound when a new approval arrives."
                    )

                    Spacer(minLength: 16)

                    Toggle("Notification sounds", isOn: soundBinding)
                        .labelsHidden()
                        .toggleStyle(.switch)
                }

                Divider()

                HStack(alignment: .center, spacing: 16) {
                    settingsRowTitle(
                        title: "Auto-expand selected request",
                        detail: "Show the selected request preview while navigating with the keyboard."
                    )

                    Spacer(minLength: 16)

                    Toggle("Auto-expand selected request", isOn: autoExpandBinding)
                        .labelsHidden()
                        .toggleStyle(.switch)
                }

                Divider()

                HStack(alignment: .center, spacing: 16) {
                    settingsRowTitle(
                        title: "Launch at login",
                        detail: "Automatically start Airlock Companion when you log in."
                    )

                    Spacer(minLength: 16)

                    Toggle("Launch at login", isOn: $launchAtLogin)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .onChange(of: launchAtLogin) { _, newValue in
                            do {
                                if newValue {
                                    try SMAppService.mainApp.register()
                                } else {
                                    try SMAppService.mainApp.unregister()
                                }
                            } catch {
                                launchAtLogin = SMAppService.mainApp.status == .enabled
                            }
                        }
                }
            }
        }
    }

    private var shortcutsCard: some View {
        settingsCard(title: "Shortcuts", subtitle: "Global keyboard controls") {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    shortcutPicker(
                        title: "Open popover",
                        value: .constant("A"),
                        disabled: true,
                        note: "Fixed"
                    )

                    shortcutPicker(
                        title: "Approve selected",
                        value: Binding(
                            get: { viewModel.approveShortcutKey },
                            set: { newValue in
                                viewModel.approveShortcutKey = newValue
                                viewModel.updateSettings()
                            }
                        )
                    )

                    shortcutPicker(
                        title: "Deny selected",
                        value: Binding(
                            get: { viewModel.denyShortcutKey },
                            set: { newValue in
                                viewModel.denyShortcutKey = newValue
                                viewModel.updateSettings()
                            }
                        )
                    )
                }

                Text("All shortcuts use Control-Shift plus the selected letter.")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    @ViewBuilder
    private var diagnosticsCard: some View {
        if !viewModel.lastNotificationActionError.isEmpty || !viewModel.lastNotificationDeliveryError.isEmpty {
            settingsCard(title: "Notification Diagnostics", subtitle: "Recent delivery or action failures") {
                VStack(alignment: .leading, spacing: 14) {
                    if !viewModel.lastNotificationActionError.isEmpty {
                        diagnosticRow(
                            title: "Last action error",
                            message: viewModel.lastNotificationActionError,
                            icon: "exclamationmark.triangle.fill"
                        )
                    }

                    if !viewModel.lastNotificationDeliveryError.isEmpty {
                        diagnosticRow(
                            title: "Last delivery error",
                            message: viewModel.lastNotificationDeliveryError,
                            icon: "bell.slash.fill"
                        )
                    }

                    HStack {
                        Spacer()
                        Button("Clear Diagnostics") {
                            viewModel.clearNotificationDiagnostics()
                        }
                        .controlSize(.small)
                    }
                }
            }
        }
    }

    private var updatesCard: some View {
        settingsCard(title: "Updates", subtitle: "Version and release info") {
            VStack(alignment: .leading, spacing: 14) {
                infoRow(label: "Current version", value: viewModel.appVersion)

                if let availableUpdateVersion = viewModel.availableUpdateVersion {
                    Divider()

                    HStack(alignment: .center, spacing: 12) {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(.orange)

                        VStack(alignment: .leading, spacing: 3) {
                            Text("Version \(availableUpdateVersion) is available")
                                .font(.system(size: 13, weight: .semibold))
                            Text("Direct-download builds can update in place; Homebrew installs should upgrade through Brew.")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }

                        Spacer()
                    }
                    .padding(14)
                    .background(Color.orange.opacity(0.10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(Color.orange.opacity(0.22), lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }

                Divider()

                HStack {
                    settingsRowTitle(
                        title: "Release channel",
                        detail: "Companion releases are published from GitHub tags and mirrored to Homebrew."
                    )

                    Spacer()

                    Link("airlock.bot", destination: URL(string: "https://airlock.bot")!)
                        .font(.system(size: 12, weight: .medium))
                }
            }
        }
    }

    private var connectionIndicator: some View {
        statusPill(displayedConnectionStatus)
    }

    private var updateStatusBadge: (title: String, tint: Color) {
        switch viewModel.updateCheckStatus {
        case .checking:
            return ("Checking updates", .gray)
        case .current:
            return ("Up to date", .green)
        case .updateAvailable:
            return ("Update available", .orange)
        case .localBuild:
            return ("Local build", Color.accentColor.opacity(0.9))
        case .failed:
            return ("Update check failed", .red)
        }
    }

    private var displayedConnectionStatus: (title: String, detail: String?, tint: Color) {
        if hasConnectionError {
            return connectionStatus
        }
        return testConnectionState?.status ?? connectionStatus
    }

    private func statusPill(_ status: (title: String, detail: String?, tint: Color)) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(status.tint)
                .frame(width: 8, height: 8)

            Text(status.title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(status.tint)
                .lineLimit(1)
                .minimumScaleFactor(0.85)

            if let detail = status.detail {
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(status.tint.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var connectionStatus: (title: String, detail: String?, tint: Color) {
        switch viewModel.connectionState {
        case .connected:
            if viewModel.gatewayToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return ("Connected", "no token saved", .orange)
            }
            return ("Connected", "authenticated", .green)
        case .connecting:
            return ("Connecting", nil, .orange)
        case .disconnected(let error):
            guard let error, !error.isEmpty else {
                return ("Disconnected", nil, .red)
            }
            if error.localizedCaseInsensitiveContains("authentication") ||
                error.contains("401") ||
                error.contains("403") {
                return ("Not authorized", "check token", .red)
            }
            return ("Disconnected", error, .red)
        }
    }

    private var hasConnectionError: Bool {
        if case .disconnected(let error) = viewModel.connectionState {
            return error != nil
        }
        return false
    }

    private enum TestConnectionState: Equatable {
        case testing
        case succeeded(authenticated: Bool)
        case failed(String)

        var status: (title: String, detail: String?, tint: Color) {
            switch self {
            case .testing:
                return ("Testing connection", nil, .orange)
            case .succeeded(let authenticated):
                if authenticated {
                    return ("Connection test passed", "token accepted", .green)
                }
                return ("Connection test passed", "no token used", .orange)
            case .failed(let error):
                if error.localizedCaseInsensitiveContains("authentication") ||
                    error.contains("401") ||
                    error.contains("403") {
                    return ("Connection test failed", "token rejected", .red)
                }
                return ("Connection test failed", error, .red)
            }
        }
    }

    private func settingsCard<Content: View>(title: String, subtitle: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }

            content()
        }
        .padding(18)
        .background(.ultraThinMaterial)
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func shortcutPicker(title: String, value: Binding<String>, disabled: Bool = false, note: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)

            if disabled {
                HStack {
                    Text("Control-Shift-\(value.wrappedValue)")
                        .font(.system(size: 13, weight: .medium))
                    Spacer()
                    if let note {
                        Text(note)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                Picker(title, selection: value) {
                    ForEach(shortcutKeys, id: \.self) { key in
                        Text("Control-Shift-\(key)")
                            .tag(key)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func settingsRowTitle(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
            Text(detail)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)

            Spacer()

            Text(value)
                .font(.system(size: 12, weight: .semibold))
        }
    }

    private func diagnosticRow(title: String, message: String, icon: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.red)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(Color.red.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.red.opacity(0.16), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func statusBadge(title: String, tint: Color) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(tint.opacity(0.14))
            .foregroundStyle(tint)
            .clipShape(Capsule())
    }

    private var appIcon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor,
                            Color.accentColor.opacity(0.78)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            Image(systemName: "lock.shield.fill")
                .resizable()
                .scaledToFit()
                .foregroundStyle(.black)
                .padding(14)
        }
        .frame(width: 68, height: 68)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 8)
    }

    private var densityBinding: Binding<String> {
        Binding(
            get: { viewModel.displayDensity },
            set: { newValue in
                viewModel.displayDensity = newValue
                viewModel.updateSettings()
            }
        )
    }

    private var soundBinding: Binding<Bool> {
        Binding(
            get: { viewModel.soundEnabled },
            set: { newValue in
                viewModel.soundEnabled = newValue
                viewModel.updateSettings()
            }
        )
    }

    private var autoExpandBinding: Binding<Bool> {
        Binding(
            get: { viewModel.autoExpandSelectedRequest },
            set: { newValue in
                viewModel.autoExpandSelectedRequest = newValue
                viewModel.updateSettings()
            }
        )
    }

    private var windowBackground: some View {
        LinearGradient(
            colors: [
                Color(nsColor: .windowBackgroundColor),
                Color.accentColor.opacity(0.05)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea()
    }

    private func applyConnectionSettings() {
        _ = saveConnectionSettingsIfNeeded(showMissingURLError: false)
    }

    private func draftConnectionSettings(showMissingURLError: Bool) -> (baseURL: String, bearerToken: String)? {
        let trimmedURL = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedURL.isEmpty else {
            if showMissingURLError {
                testConnectionState = .failed("Airlock URL is required")
            }
            return nil
        }
        return (trimmedURL, trimmedToken)
    }

    private func saveConnectionSettingsIfNeeded(showMissingURLError: Bool) -> Bool {
        guard let draft = draftConnectionSettings(showMissingURLError: showMissingURLError) else { return false }
        let trimmedURL = draft.baseURL
        let trimmedToken = draft.bearerToken
        guard trimmedURL != viewModel.dashboardURL || trimmedToken != viewModel.gatewayToken else {
            urlText = trimmedURL
            tokenText = trimmedToken
            return true
        }

        do {
            try viewModel.saveConnectionSettings(baseURL: trimmedURL, bearerToken: trimmedToken)
            urlText = trimmedURL
            tokenText = trimmedToken
            testConnectionState = nil
            return true
        } catch {
            testConnectionState = .failed(error.localizedDescription)
            return false
        }
    }

    private func testConnectionSettings() {
        guard let draft = draftConnectionSettings(showMissingURLError: true) else { return }

        testConnectionState = .testing
        Task {
            do {
                try await viewModel.testConnection(baseURL: draft.baseURL, bearerToken: draft.bearerToken)
                await MainActor.run {
                    urlText = draft.baseURL
                    tokenText = draft.bearerToken
                    testConnectionState = .succeeded(authenticated: !draft.bearerToken.isEmpty)
                }
            } catch {
                await MainActor.run {
                    testConnectionState = .failed(error.localizedDescription)
                }
            }
        }
    }
}
