import AppKit
import CompanionKit
import SwiftUI

enum CompanionMacMetrics {
    static let space: CGFloat = 4
    static let sidebarWidth: CGFloat = 280
    static let transcriptMaxWidth: CGFloat = 860
}

extension Color {
    /// These use AppKit semantic colors so the shell follows the user's light/dark appearance
    /// without a second theme preference or a custom blur layer.
    static let companionMacCanvas = Color(nsColor: .underPageBackgroundColor)
    static let companionMacSurface = Color(nsColor: .controlBackgroundColor)
    static let companionMacRaised = Color(nsColor: .textBackgroundColor)
    static let companionMacInk = Color(nsColor: .labelColor)
    static let companionMacMuted = Color(nsColor: .secondaryLabelColor)
    static let companionMacDivider = Color(nsColor: .separatorColor)
    static let companionMacAccent = Color(red: 0.81, green: 0.66, blue: 0.12)
    static let companionMacAccentForeground = Color.black.opacity(0.82)
    static let companionMacSuccess = Color(red: 0.22, green: 0.58, blue: 0.33)
    static let companionMacWarning = Color(red: 0.78, green: 0.49, blue: 0.10)
    static let companionMacDanger = Color(red: 0.75, green: 0.20, blue: 0.19)
    static let companionMacUnknown = Color(nsColor: .tertiaryLabelColor)
}

struct CompanionMacSurface<Content: View>: View {
    let content: Content
    var padding: CGFloat = CompanionMacMetrics.space * 4

    init(
        padding: CGFloat = CompanionMacMetrics.space * 4,
        @ViewBuilder content: () -> Content
    ) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .background(Color.companionMacSurface)
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.companionMacDivider.opacity(0.72), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct CompanionMacStatusBadge: View {
    let runtime: CompanionSummary.Runtime

    var body: some View {
        HStack(spacing: CompanionMacMetrics.space * 1.5) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.callout.weight(.medium))
        }
        .foregroundStyle(Color.companionMacInk)
        .padding(.horizontal, CompanionMacMetrics.space * 2)
        .padding(.vertical, CompanionMacMetrics.space)
        .background(Color.companionMacRaised, in: Capsule())
        .overlay(Capsule().stroke(Color.companionMacDivider, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Box, \(label.lowercased())")
    }

    private var label: String {
        if runtime.replying { return "Replying" }
        switch runtime.state {
        case .running: return "Online"
        case .provisioning: return "Starting"
        case .stopping: return "Stopping"
        case .error: return "Error"
        case .notCreated, .stopped: return "Asleep"
        case .unknown: return "Unknown"
        }
    }

    private var color: Color {
        if runtime.replying { return .companionMacAccent }
        switch runtime.state {
        case .running: return .companionMacSuccess
        case .provisioning, .stopping: return .companionMacWarning
        case .error: return .companionMacDanger
        case .notCreated, .stopped, .unknown: return .companionMacUnknown
        }
    }
}

struct CompanionMacErrorNotice: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.callout)
        .foregroundStyle(Color.companionMacDanger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(CompanionMacMetrics.space * 3)
        .background(Color.companionMacDanger.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
        .overlay {
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.companionMacDanger.opacity(0.32), lineWidth: 1)
        }
        .accessibilityLabel("Error: \(message)")
    }
}

struct CompanionMacAvatar: View {
    let name: String
    let icon: CompanionSummary.Icon?
    var size: CGFloat = 44
    var thinking = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var color: Color {
        // Keep the color catalogue deterministic while gracefully handling older/null icons.
        let palette: [Color] = [
            .gray, .brown, .red, .orange, .yellow, .green, .mint, .blue, .purple, .pink, .gray,
        ]
        let index = min(max(icon?.color ?? 2, 0), palette.count - 1)
        return palette[index]
    }

    var body: some View {
        Group {
            if reduceMotion {
                artwork(scale: 1, sparkleOpacity: thinking ? 1 : 0)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 24)) { timeline in
                    let phase = timeline.date.timeIntervalSinceReferenceDate
                    let scale = thinking
                        ? 1 + 0.035 * sin(phase * 5.7)
                        : 1 + 0.014 * sin(phase * 1.8)
                    let sparkleOpacity = thinking ? 0.45 + 0.45 * sin(phase * 5.7) : 0
                    artwork(scale: scale, sparkleOpacity: sparkleOpacity)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name), Companion")
    }

    private func artwork(scale: CGFloat, sparkleOpacity: Double) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
                .fill(color.opacity(0.92))
                .overlay {
                    RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
                        .stroke(Color.black.opacity(0.12), lineWidth: 1)
                }
                .scaleEffect(scale)

            HStack(spacing: size * 0.11) {
                Circle().fill(Color.black.opacity(0.76)).frame(width: size * 0.105, height: size * 0.15)
                Circle().fill(Color.black.opacity(0.76)).frame(width: size * 0.105, height: size * 0.15)
            }
            .offset(y: -size * 0.06)

            Capsule()
                .fill(Color.black.opacity(0.76))
                .frame(width: size * 0.20, height: size * 0.06)
                .offset(y: size * 0.15)

            if thinking {
                Image(systemName: "sparkles")
                    .font(.system(size: size * 0.20, weight: .bold))
                    .foregroundStyle(Color.companionMacAccent)
                    .opacity(sparkleOpacity)
                    .offset(x: size * 0.32, y: -size * 0.34)
            }
        }
    }
}

extension View {
    func companionMacFocusRing(_ focused: Bool) -> some View {
        overlay {
            if focused {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color.companionMacAccent, lineWidth: 2)
                    .padding(-2)
            }
        }
    }
}

func companionMacErrorMessage(_ error: Error, fallback: String) -> String {
    if let apiError = error as? APIError, !apiError.message.isEmpty {
        return apiError.message
    }
    return fallback
}
