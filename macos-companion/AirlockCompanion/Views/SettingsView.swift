import AppKit
import SwiftUI

struct SettingsView: View {
    @ObservedObject var viewModel: AppViewModel
    @State private var urlText: String = ""

    private let shortcutKeys = (65...90).compactMap { UnicodeScalar($0).map(String.init) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerCard
                preferencesCard
                shortcutsCard
                updatesCard
            }
            .padding(24)
        }
        .frame(width: 540, height: 520)
        .background(windowBackground)
        .onAppear {
            urlText = viewModel.dashboardURL
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
                    statusBadge(
                        title: viewModel.availableUpdateVersion == nil ? "Up to date" : "Update available",
                        tint: viewModel.availableUpdateVersion == nil ? Color.green : Color.orange
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
                    Text("Dashboard URL")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)

                    TextField(
                        "http://127.0.0.1:4112",
                        text: $urlText
                    )
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 13, design: .monospaced))
                    .onSubmit(applyDashboardURL)

                    HStack {
                        Text("Press Return to apply a new dashboard URL.")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)

                        Spacer()

                        Button("Apply") {
                            applyDashboardURL()
                        }
                        .controlSize(.small)
                    }
                }

                Divider()

                HStack(alignment: .center, spacing: 16) {
                    settingsRowTitle(
                        title: "Display density",
                        detail: "Controls the width of the popover."
                    )

                    Spacer(minLength: 16)

                    Picker("Display density", selection: densityBinding) {
                        ForEach(DisplayDensity.allCases, id: \.rawValue) { density in
                            Text(density.displayName).tag(density.rawValue)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .frame(width: 210)
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

    private func applyDashboardURL() {
        let trimmedURL = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedURL.isEmpty else { return }
        guard trimmedURL != viewModel.dashboardURL else {
            urlText = trimmedURL
            return
        }

        viewModel.dashboardURL = trimmedURL
        urlText = trimmedURL
        viewModel.updateSettings()
    }
}
