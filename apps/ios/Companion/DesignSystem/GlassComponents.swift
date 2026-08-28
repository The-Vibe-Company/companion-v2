import SwiftUI
import CompanionKit

struct CompanionBackdrop<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ZStack {
            CompanionIOSTheme.canvas
                .ignoresSafeArea()

            content
        }
    }
}

extension View {
    func companionGlass(
        radius: CGFloat,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        modifier(CompanionGlassModifier(radius: radius, tint: tint, interactive: interactive))
    }

    func companionMaterial(radius: CGFloat, tint: Color? = nil) -> some View {
        modifier(CompanionMaterialModifier(radius: radius, tint: tint))
    }
}

private struct CompanionGlassModifier: ViewModifier {
    let radius: CGFloat
    let tint: Color?
    let interactive: Bool

    func body(content: Content) -> some View {
        content
            .background(
                tint?.opacity(interactive ? 0.10 : 0.06) ?? CompanionIOSTheme.card,
                in: RoundedRectangle(cornerRadius: radius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
            }
    }
}

private struct CompanionMaterialModifier: ViewModifier {
    let radius: CGFloat
    let tint: Color?

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(CompanionIOSTheme.card)
                    .overlay {
                        if let tint {
                            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(tint)
                        }
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
            }
    }
}

struct CompanionStatusBadge: View {
    let runtime: CompanionSummary.Runtime
    var compact = false
    var replyingColor = CompanionIOSTheme.actionBlue

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(CompanionIOSTheme.textPrimary.opacity(0.78))
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 5 : 6)
        .background {
            if !compact {
                Capsule().fill(CompanionIOSTheme.card)
            }
        }
        .overlay {
            if !compact {
                Capsule().stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Box, \(label.lowercased())")
    }

    var label: String {
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

    private var statusColor: Color {
        if runtime.replying { return replyingColor }
        switch runtime.state {
        case .running: return .companionSuccess
        case .provisioning, .stopping: return .companionWarning
        case .error: return .companionDanger
        case .notCreated, .stopped, .unknown: return .companionMuted
        }
    }
}

struct CompanionVisualTheme {
    let accent = CompanionIOSTheme.actionBlue
    let accentForeground = Color.white

    init(icon _: CompanionSummary.Icon?) {}
}
