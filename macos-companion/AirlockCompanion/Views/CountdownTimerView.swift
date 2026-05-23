import SwiftUI

struct CountdownTimerView: View {
    let deadline: Date
    let totalDuration: TimeInterval

    private func remainingSeconds(at currentTime: Date) -> TimeInterval {
        max(0, deadline.timeIntervalSince(currentTime))
    }

    private func progress(at currentTime: Date) -> Double {
        guard totalDuration > 0 else { return 0 }
        return remainingSeconds(at: currentTime) / totalDuration
    }

    private func color(for progress: Double) -> Color {
        if progress > 0.5 {
            return .green
        } else if progress > 0.2 {
            return .yellow
        } else {
            return .red
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remainingSeconds = remainingSeconds(at: context.date)
            let progress = progress(at: context.date)
            let color = color(for: progress)

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
}
