import SwiftUI

struct CountdownTimerView: View {
    let deadline: Date
    let totalDuration: TimeInterval
    let currentTime: Date

    private var remainingSeconds: TimeInterval {
        max(0, deadline.timeIntervalSince(currentTime))
    }

    private var progress: Double {
        guard totalDuration > 0 else { return 0 }
        return remainingSeconds / totalDuration
    }

    private var color: Color {
        if progress > 0.5 {
            return .green
        } else if progress > 0.2 {
            return .yellow
        } else {
            return .red
        }
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.2), lineWidth: 3)

            Circle()
                .trim(from: 0, to: progress)
                .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 1), value: progress)

            Text("\(Int(remainingSeconds))")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
        }
        .frame(width: 32, height: 32)
    }
}
