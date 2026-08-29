import CompanionKit
import SwiftUI

struct CompanionStatusDot: View {
    let status: CompanionStatusIndicatorState

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(runtime: CompanionSummary.Runtime) {
        status = CompanionStatusIndicatorState(runtime: runtime)
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(tint)
                .frame(width: 8, height: 8)

            if status.shouldPulse(reduceMotion: reduceMotion) {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { context in
                    let phase = pulsePhase(at: context.date)
                    Circle()
                        .stroke(tint.opacity(0.35), lineWidth: 1)
                        .frame(width: 8, height: 8)
                        .scaleEffect(1 + (phase * 0.65))
                        .opacity(Double(0.7 * (1 - phase)))
                }
            }
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
    }

    private var tint: Color {
        switch status.tint {
        case .live: return CompanionIOSTheme.toggleGreen
        case .inactive: return CompanionIOSTheme.textSecondary
        case .error: return CompanionIOSTheme.danger
        }
    }

    private func pulsePhase(at date: Date) -> CGFloat {
        let duration = 1.4
        return CGFloat(date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: duration) / duration)
    }
}
