import SwiftUI

struct EmptyStateView: View {
    let connectionState: ConnectionState

    private var statusText: String {
        switch connectionState {
        case .connected:
            return "Connected to Airlock"
        case .connecting:
            return "Connecting..."
        case .disconnected(let error):
            if let error {
                return "Disconnected: \(error)"
            }
            return "Disconnected"
        }
    }

    private var statusColor: Color {
        switch connectionState {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return .red
        }
    }

    var body: some View {
        VStack(spacing: 12) {
            Spacer()

            Image(systemName: "lock.shield")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)

            Text("No pending requests")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)

            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 6, height: 6)

                Text(statusText)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding()
    }
}
