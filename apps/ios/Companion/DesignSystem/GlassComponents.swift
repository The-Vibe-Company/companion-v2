import SwiftUI
import CompanionKit

enum CompanionBackdropStyle {
    case decorative
    case neutral
    case companion(Color)
}

struct CompanionBackdrop<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let style: CompanionBackdropStyle
    let content: Content

    init(
        style: CompanionBackdropStyle = .decorative,
        @ViewBuilder content: () -> Content
    ) {
        self.style = style
        self.content = content()
    }

    var body: some View {
        ZStack {
            Color.companionCanvas
                .ignoresSafeArea()

            switch style {
            case .neutral:
                EmptyView()
            case .companion(_) where reduceTransparency:
                EmptyView()
            case .companion(let color):
                color
                    .opacity(0.10)
                    .ignoresSafeArea()
                    .accessibilityHidden(true)
            case .decorative where !reduceTransparency:
                GeometryReader { geometry in
                    Circle()
                        .fill(Color.companionAccent.opacity(0.18))
                        .frame(width: geometry.size.width * 0.86)
                        .blur(radius: 68)
                        .offset(x: -geometry.size.width * 0.34, y: -geometry.size.height * 0.18)

                    Circle()
                        .fill(Color.companionAccentGold.opacity(0.20))
                        .frame(width: geometry.size.width * 0.72)
                        .blur(radius: 72)
                        .offset(x: geometry.size.width * 0.52, y: geometry.size.height * 0.18)

                    Circle()
                        .fill(Color(red: 0.34, green: 0.62, blue: 1).opacity(0.15))
                        .frame(width: geometry.size.width * 0.92)
                        .blur(radius: 84)
                        .offset(x: -geometry.size.width * 0.18, y: geometry.size.height * 0.72)
                }
                .ignoresSafeArea()
                .accessibilityHidden(true)
            case .decorative:
                EmptyView()
            }

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
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let radius: CGFloat
    let tint: Color?
    let interactive: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(
                    tint?.opacity(0.16) ?? Color.companionSurface,
                    in: RoundedRectangle(cornerRadius: radius, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .stroke(Color.companionDivider, lineWidth: 0.7)
                }
        } else {
            let base = Glass.regular.tint(tint)
            content.glassEffect(
                interactive ? base.interactive() : base,
                in: .rect(cornerRadius: radius)
            )
        }
    }
}

private struct CompanionMaterialModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let radius: CGFloat
    let tint: Color?

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(
                        reduceTransparency
                            ? AnyShapeStyle(Color.companionSurfaceOpaque)
                            : AnyShapeStyle(.ultraThinMaterial)
                    )
                    .overlay {
                        if let tint {
                            RoundedRectangle(cornerRadius: radius, style: .continuous)
                                .fill(tint)
                        }
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(
                        reduceTransparency ? Color.companionDivider : Color.companionBorder,
                        lineWidth: 0.7
                    )
            }
    }
}

struct CompanionStatusBadge: View {
    let runtime: CompanionSummary.Runtime
    var compact = false
    var replyingColor = Color.companionAccent

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Color.companionInk.opacity(0.78))
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 5 : 6)
        .background {
            if !compact {
                Capsule().fill(.thinMaterial)
            }
        }
        .overlay {
            if !compact {
                Capsule().stroke(Color.companionBorder, lineWidth: 0.6)
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
    let base: Color
    let shadow: Color
    let accent: Color
    let accentForeground: Color

    var highlight: Color { base.opacity(0.54) }

    init(icon: CompanionSummary.Icon?) {
        let colorIndex = Self.clamp(icon?.color, count: Self.palette.count, fallback: 2)
        self = Self.palette[colorIndex]
    }

    private init(base: Color, shadow: Color, accent: Color, accentForeground: Color = .white) {
        self.base = base
        self.shadow = shadow
        self.accent = accent
        self.accentForeground = accentForeground
    }

    private static func clamp(_ value: Int?, count: Int, fallback: Int) -> Int {
        guard let value, (0..<count).contains(value) else { return fallback }
        return value
    }

    private static let palette: [CompanionVisualTheme] = [
        .init(
            base: .init(red: 0.92, green: 0.92, blue: 0.90),
            shadow: .init(red: 0.70, green: 0.70, blue: 0.66),
            accent: .init(red: 0.34, green: 0.34, blue: 0.31)
        ),
        .init(
            base: .init(red: 0.54, green: 0.42, blue: 0.31),
            shadow: .init(red: 0.36, green: 0.26, blue: 0.18),
            accent: .init(red: 0.36, green: 0.26, blue: 0.18)
        ),
        .init(
            base: .init(red: 0.91, green: 0.20, blue: 0.25),
            shadow: .init(red: 0.70, green: 0.08, blue: 0.13),
            accent: .init(red: 0.65, green: 0.06, blue: 0.11)
        ),
        .init(
            base: .init(red: 0.96, green: 0.47, blue: 0.10),
            shadow: .init(red: 0.78, green: 0.28, blue: 0.03),
            accent: .init(red: 0.62, green: 0.20, blue: 0.01)
        ),
        .init(
            base: .init(red: 0.96, green: 0.69, blue: 0.10),
            shadow: .init(red: 0.78, green: 0.48, blue: 0.04),
            accent: .init(red: 0.50, green: 0.28, blue: 0.01)
        ),
        .init(
            base: .init(red: 0.22, green: 0.67, blue: 0.38),
            shadow: .init(red: 0.10, green: 0.48, blue: 0.24),
            accent: .init(red: 0.07, green: 0.39, blue: 0.18)
        ),
        .init(
            base: .init(red: 0.18, green: 0.66, blue: 0.55),
            shadow: .init(red: 0.08, green: 0.46, blue: 0.37),
            accent: .init(red: 0.05, green: 0.38, blue: 0.30)
        ),
        .init(
            base: .init(red: 0.22, green: 0.46, blue: 0.95),
            shadow: .init(red: 0.10, green: 0.29, blue: 0.76),
            accent: .init(red: 0.08, green: 0.24, blue: 0.62)
        ),
        .init(
            base: .init(red: 0.54, green: 0.34, blue: 0.96),
            shadow: .init(red: 0.38, green: 0.19, blue: 0.78),
            accent: .init(red: 0.30, green: 0.12, blue: 0.66)
        ),
        .init(
            base: .init(red: 0.89, green: 0.31, blue: 0.63),
            shadow: .init(red: 0.72, green: 0.16, blue: 0.48),
            accent: .init(red: 0.60, green: 0.09, blue: 0.37)
        ),
        .init(
            base: .init(red: 0.58, green: 0.61, blue: 0.65),
            shadow: .init(red: 0.41, green: 0.44, blue: 0.48),
            accent: .init(red: 0.31, green: 0.33, blue: 0.36)
        ),
    ]
}
