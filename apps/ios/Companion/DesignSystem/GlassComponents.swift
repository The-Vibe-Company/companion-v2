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

    func companionMaterial(radius: CGFloat) -> some View {
        modifier(CompanionMaterialModifier(radius: radius))
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
                    tint?.opacity(0.16) ?? Color.white,
                    in: RoundedRectangle(cornerRadius: radius, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .stroke(Color.black.opacity(0.10), lineWidth: 0.7)
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

    func body(content: Content) -> some View {
        content
            .background(
                reduceTransparency ? AnyShapeStyle(Color.white) : AnyShapeStyle(.ultraThinMaterial),
                in: RoundedRectangle(cornerRadius: radius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(reduceTransparency ? Color.black.opacity(0.10) : Color.companionBorder, lineWidth: 0.7)
            }
    }
}

struct CompanionAvatar: View {
    let name: String
    var icon: CompanionSummary.Icon?
    var size: CGFloat = 48
    var isReplying = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var thinking = false

    private var configuration: AvatarConfiguration {
        AvatarConfiguration(icon: icon)
    }

    var body: some View {
        ZStack {
            CompanionBlobShape(index: configuration.shape)
                .fill(
                    RadialGradient(
                        colors: [configuration.theme.highlight, configuration.theme.base, configuration.theme.shadow],
                        center: .topLeading,
                        startRadius: 2,
                        endRadius: size * 0.78
                    )
                )
                .shadow(color: configuration.theme.shadow.opacity(0.2), radius: 5, y: 3)

            face
            accessory

            if isReplying {
                Image(systemName: "sparkle")
                    .font(.system(size: size * 0.22, weight: .bold))
                    .foregroundStyle(Color.companionAccentGold)
                    .offset(x: size * 0.41, y: -size * 0.39)
                    .scaleEffect(thinking ? 1.08 : 0.84)
                    .opacity(thinking ? 1 : 0.62)
            }
        }
        .frame(width: size, height: size)
        .scaleEffect(isReplying && thinking ? 0.97 : 1)
        .task(id: isReplying) {
            guard isReplying, !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                thinking = true
            }
        }
        .accessibilityLabel("\(name), \(isReplying ? "replying" : "Companion")")
    }

    private var face: some View {
        VStack(spacing: size * 0.09) {
            HStack(spacing: size * 0.17) {
                Capsule().frame(width: size * 0.07, height: size * 0.13)
                Capsule().frame(width: size * 0.07, height: size * 0.13)
            }
            .offset(y: size * 0.05)

            mouth
        }
        .foregroundStyle(Color.companionInk)
    }

    @ViewBuilder
    private var mouth: some View {
        switch configuration.mouth {
        case 0:
            Color.clear.frame(width: 1, height: size * 0.08)
        case 2:
            Circle().frame(width: size * 0.09, height: size * 0.11)
        case 3:
            Image(systemName: "mustache.fill")
                .font(.system(size: size * 0.16, weight: .medium))
        case 4:
            Capsule().frame(width: size * 0.18, height: size * 0.08)
        default:
            CompanionSmile()
                .stroke(Color.companionInk, style: StrokeStyle(lineWidth: max(1.5, size * 0.035), lineCap: .round))
                .frame(width: size * 0.18, height: size * 0.10)
        }
    }

    @ViewBuilder
    private var accessory: some View {
        switch configuration.accessory {
        case 1:
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: size * 0.25, weight: .bold))
                .foregroundStyle(Color.companionAccentGold)
                .offset(y: -size * 0.48)
        case 2:
            Ellipse()
                .stroke(Color.companionAccentGold, lineWidth: max(2, size * 0.04))
                .frame(width: size * 0.48, height: size * 0.13)
                .offset(y: -size * 0.48)
        case 3:
            Image(systemName: "crown.fill")
                .font(.system(size: size * 0.27, weight: .bold))
                .foregroundStyle(Color.companionAccentGold)
                .offset(y: -size * 0.45)
        case 4:
            Image(systemName: "bowtie.fill")
                .font(.system(size: size * 0.24, weight: .bold))
                .foregroundStyle(.pink)
                .offset(x: size * 0.38, y: -size * 0.26)
        case 5:
            Image(systemName: "headphones")
                .font(.system(size: size * 0.56, weight: .medium))
                .foregroundStyle(.gray)
        case 6:
            Image(systemName: "sparkles")
                .font(.system(size: size * 0.22, weight: .bold))
                .foregroundStyle(Color.companionAccentGold)
                .offset(x: size * 0.38, y: -size * 0.34)
        default:
            EmptyView()
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
        .background(.thinMaterial, in: Capsule())
        .overlay { Capsule().stroke(Color.companionBorder, lineWidth: 0.6) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Box, \(label.lowercased())")
    }

    var label: String {
        if runtime.replying { return "Replying" }
        switch runtime.state {
        case .running: return "Online"
        case .provisioning: return "Starting"
        case .error: return "Error"
        case .notCreated, .stopped, .stopping: return "Asleep"
        case .unknown: return "Unknown"
        }
    }

    private var statusColor: Color {
        if runtime.replying { return replyingColor }
        switch runtime.state {
        case .running: return .companionSuccess
        case .provisioning: return .companionWarning
        case .error: return .companionDanger
        case .notCreated, .stopped, .stopping, .unknown: return .companionMuted
        }
    }
}

private struct AvatarConfiguration {
    let shape: Int
    let mouth: Int
    let accessory: Int
    let theme: CompanionVisualTheme

    init(icon: CompanionSummary.Icon?) {
        shape = Self.clamp(icon?.shape, count: 8, fallback: 1)
        mouth = Self.clamp(icon?.mouth, count: 5, fallback: 1)
        accessory = Self.clamp(icon?.accessory, count: 7, fallback: 1)
        theme = CompanionVisualTheme(icon: icon)
    }

    private static func clamp(_ value: Int?, count: Int, fallback: Int) -> Int {
        guard let value, (0..<count).contains(value) else { return fallback }
        return value
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

private struct CompanionBlobShape: Shape {
    let index: Int

    func path(in rect: CGRect) -> Path {
        let inset = rect.insetBy(dx: rect.width * 0.06, dy: rect.height * 0.06)
        switch index {
        case 0:
            return Path(ellipseIn: inset)
        case 2:
            return RoundedRectangle(cornerRadius: rect.width * 0.24, style: .continuous).path(in: inset)
        case 3:
            return RoundedRectangle(cornerRadius: rect.width * 0.42, style: .continuous).path(in: inset.insetBy(dx: rect.width * 0.08, dy: 0))
        case 4:
            var path = Path()
            path.move(to: CGPoint(x: rect.midX, y: inset.minY))
            path.addCurve(to: CGPoint(x: inset.maxX, y: inset.maxY * 0.90), control1: CGPoint(x: rect.midX * 1.25, y: inset.minY), control2: CGPoint(x: inset.maxX, y: rect.midY))
            path.addCurve(to: CGPoint(x: inset.minX, y: inset.maxY * 0.90), control1: CGPoint(x: rect.midX * 1.25, y: inset.maxY), control2: CGPoint(x: rect.midX * 0.60, y: inset.maxY))
            path.addCurve(to: CGPoint(x: rect.midX, y: inset.minY), control1: CGPoint(x: inset.minX, y: rect.midY), control2: CGPoint(x: rect.midX * 0.75, y: inset.minY))
            return path
        case 5:
            var path = Path()
            let points = [
                CGPoint(x: rect.midX, y: inset.minY), CGPoint(x: inset.maxX, y: rect.height * 0.28),
                CGPoint(x: inset.maxX, y: rect.height * 0.72), CGPoint(x: rect.midX, y: inset.maxY),
                CGPoint(x: inset.minX, y: rect.height * 0.72), CGPoint(x: inset.minX, y: rect.height * 0.28),
            ]
            path.addLines(points + [points[0]])
            return path
        case 6:
            var path = Path()
            path.move(to: CGPoint(x: inset.minX, y: rect.height * 0.64))
            path.addCurve(to: CGPoint(x: rect.width * 0.30, y: rect.height * 0.34), control1: CGPoint(x: inset.minX, y: rect.height * 0.48), control2: CGPoint(x: rect.width * 0.16, y: rect.height * 0.35))
            path.addCurve(to: CGPoint(x: rect.width * 0.72, y: rect.height * 0.29), control1: CGPoint(x: rect.width * 0.39, y: rect.height * 0.08), control2: CGPoint(x: rect.width * 0.66, y: rect.height * 0.12))
            path.addCurve(to: CGPoint(x: inset.maxX, y: rect.height * 0.58), control1: CGPoint(x: rect.width * 0.90, y: rect.height * 0.26), control2: CGPoint(x: inset.maxX, y: rect.height * 0.40))
            path.addCurve(to: CGPoint(x: rect.width * 0.68, y: inset.maxY), control1: CGPoint(x: inset.maxX, y: rect.height * 0.85), control2: CGPoint(x: rect.width * 0.82, y: inset.maxY))
            path.addLine(to: CGPoint(x: rect.width * 0.28, y: inset.maxY))
            path.addCurve(to: CGPoint(x: inset.minX, y: rect.height * 0.64), control1: CGPoint(x: rect.width * 0.13, y: inset.maxY), control2: CGPoint(x: inset.minX, y: rect.height * 0.79))
            return path
        case 7:
            var path = Path()
            path.move(to: CGPoint(x: rect.midX, y: inset.minY))
            path.addCurve(to: CGPoint(x: rect.midX, y: inset.maxY), control1: CGPoint(x: inset.maxX, y: rect.height * 0.44), control2: CGPoint(x: inset.maxX, y: inset.maxY))
            path.addCurve(to: CGPoint(x: rect.midX, y: inset.minY), control1: CGPoint(x: inset.minX, y: inset.maxY), control2: CGPoint(x: inset.minX, y: rect.height * 0.44))
            return path
        default:
            var path = Path()
            path.move(to: CGPoint(x: rect.midX, y: inset.minY))
            path.addCurve(to: CGPoint(x: inset.maxX, y: rect.midY), control1: CGPoint(x: rect.width * 0.82, y: inset.minY), control2: CGPoint(x: inset.maxX, y: rect.height * 0.24))
            path.addCurve(to: CGPoint(x: rect.midX, y: inset.maxY), control1: CGPoint(x: inset.maxX, y: rect.height * 0.80), control2: CGPoint(x: rect.width * 0.72, y: inset.maxY))
            path.addCurve(to: CGPoint(x: inset.minX, y: rect.midY), control1: CGPoint(x: rect.width * 0.26, y: inset.maxY), control2: CGPoint(x: inset.minX, y: rect.height * 0.76))
            path.addCurve(to: CGPoint(x: rect.midX, y: inset.minY), control1: CGPoint(x: inset.minX, y: rect.height * 0.22), control2: CGPoint(x: rect.width * 0.22, y: inset.minY))
            return path
        }
    }
}

private struct CompanionSmile: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control: CGPoint(x: rect.midX, y: rect.maxY))
        return path
    }
}
