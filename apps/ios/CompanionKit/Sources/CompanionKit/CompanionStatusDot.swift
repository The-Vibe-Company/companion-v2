#if canImport(SwiftUI)
import Foundation
import SwiftUI

/// The compact status dot shared by native Companion roster and chat surfaces.
public struct CompanionStatusDot: View {
    public static let dotSize: CGFloat = 8
    public static let containerSize: CGFloat = 14
    public static let pulseDuration: TimeInterval = 1.4

    public let status: CompanionStatusIndicatorState

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(runtime: CompanionSummary.Runtime) {
        self.init(status: CompanionStatusIndicatorState(runtime: runtime))
    }

    public init(status: CompanionStatusIndicatorState) {
        self.status = status
    }

    public var body: some View {
        ZStack {
            Circle()
                .fill(tint)
                .frame(width: Self.dotSize, height: Self.dotSize)

            if status.shouldPulse(reduceMotion: reduceMotion) {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { context in
                    let phase = Self.pulsePhase(at: context.date)
                    Circle()
                        .stroke(tint.opacity(0.35), lineWidth: 1)
                        .frame(width: Self.dotSize, height: Self.dotSize)
                        .scaleEffect(1 + (phase * 0.65))
                        .opacity(Double(0.7 * (1 - phase)))
                }
            }
        }
        .frame(width: Self.containerSize, height: Self.containerSize)
        .accessibilityHidden(true)
    }

    private var tint: Color {
        switch status.tint {
        case .live: return CompanionIOSTheme.toggleGreen
        case .inactive: return CompanionIOSTheme.textSecondary
        case .error: return CompanionIOSTheme.danger
        }
    }

    private static func pulsePhase(at date: Date) -> CGFloat {
        let remainder = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: pulseDuration)
        return CGFloat((remainder + pulseDuration).truncatingRemainder(dividingBy: pulseDuration) / pulseDuration)
    }
}
#endif
