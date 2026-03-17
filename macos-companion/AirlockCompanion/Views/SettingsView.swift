import SwiftUI

struct SettingsView: View {
    @ObservedObject var viewModel: AppViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var urlText: String = ""
    @State private var soundEnabled: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Settings")
                .font(.system(size: 16, weight: .semibold))

            VStack(alignment: .leading, spacing: 6) {
                Text("Dashboard URL")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)

                TextField("http://127.0.0.1:4112", text: $urlText)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }

            Toggle("Notification sounds", isOn: $soundEnabled)
                .font(.system(size: 12))

            HStack {
                Spacer()
                Button("Save") {
                    viewModel.dashboardURL = urlText
                    viewModel.soundEnabled = soundEnabled
                    viewModel.updateSettings()
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }

            Divider()

            VStack(spacing: 6) {
                Text("Version \(viewModel.appVersion)")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)

                if let availableUpdateVersion = viewModel.availableUpdateVersion {
                    Text("Update available: \(availableUpdateVersion)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.orange)
                }

                Link(destination: URL(string: "https://airlock.bot")!) {
                    Text("airlock.bot")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .focusable(false)
                .focusEffectDisabled()
            }
            .frame(maxWidth: .infinity)
        }
        .padding(16)
        .frame(width: 300)
        .onAppear {
            urlText = viewModel.dashboardURL
            soundEnabled = viewModel.soundEnabled
        }
    }
}
