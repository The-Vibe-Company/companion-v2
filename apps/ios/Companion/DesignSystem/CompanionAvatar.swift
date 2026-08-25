import SwiftUI
import CompanionKit

enum CompanionAvatarState: Equatable {
    case idle
    case thinking
    case still
}

/// Native rendering of the web Companion icon catalog. Artwork stays in the web SVG's canonical
/// 64 × 68 coordinate space so every client renders the same silhouette, face, accessory, and crop.
struct CompanionAvatar: View {
    let name: String
    var icon: CompanionSummary.Icon?
    var size: CGFloat = 48
    var state: CompanionAvatarState = .idle

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var animationStart = Date()

    private var configuration: CompanionAvatarConfiguration {
        CompanionAvatarConfiguration(icon: icon)
    }

    var body: some View {
        Group {
            if reduceMotion || state == .still {
                artwork(at: nil)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    artwork(at: timeline.date.timeIntervalSince(animationStart))
                }
            }
        }
        .frame(width: size, height: size)
        .clipped()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name), Companion")
        .onChange(of: state) {
            animationStart = .now
        }
        .onChange(of: reduceMotion) {
            if !reduceMotion { animationStart = .now }
        }
    }

    private func artwork(at timestamp: TimeInterval?) -> some View {
        let motion = CompanionAvatarMotion.frame(for: state, timestamp: timestamp)
        return Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, canvasSize in
            CompanionAvatarRenderer.draw(
                configuration: configuration,
                state: state,
                motion: motion,
                in: canvasSize,
                context: &context
            )
        }
    }
}

private struct CompanionAvatarConfiguration {
    let shape: Int
    let mouth: Int
    let accessory: Int
    let color: CompanionAvatarColor

    init(icon: CompanionSummary.Icon?) {
        shape = Self.clamp(icon?.shape, count: CompanionAvatarCatalog.bodyPaths.count, fallback: 1)
        mouth = Self.clamp(icon?.mouth, count: 5, fallback: 1)
        accessory = Self.clamp(icon?.accessory, count: 7, fallback: 1)
        let colorIndex = Self.clamp(icon?.color, count: CompanionAvatarCatalog.colors.count, fallback: 2)
        color = CompanionAvatarCatalog.colors[colorIndex]
    }

    private static func clamp(_ value: Int?, count: Int, fallback: Int) -> Int {
        guard let value, (0..<count).contains(value) else { return fallback }
        return value
    }
}

private struct CompanionAvatarColor {
    let base: CompanionRGB
    let shadow: CompanionRGB
}

private struct CompanionRGB {
    let red: UInt8
    let green: UInt8
    let blue: UInt8

    var color: Color {
        Color(
            red: Double(red) / 255,
            green: Double(green) / 255,
            blue: Double(blue) / 255
        )
    }

    func lightened(by amount: UInt8) -> Color {
        Color(
            red: Double(min(Int(red) + Int(amount), 255)) / 255,
            green: Double(min(Int(green) + Int(amount), 255)) / 255,
            blue: Double(min(Int(blue) + Int(amount), 255)) / 255
        )
    }
}

private struct CompanionAvatarMotion {
    let bodyScaleX: CGFloat
    let bodyScaleY: CGFloat
    let faceOffsetX: CGFloat
    let faceScaleY: CGFloat
    let sparkles: [Sparkle]

    struct Sparkle {
        let opacity: Double
        let scale: CGFloat
        let rotation: CGFloat
    }

    static func frame(for state: CompanionAvatarState, timestamp: TimeInterval?) -> Self {
        guard let timestamp else {
            return Self(
                bodyScaleX: 1,
                bodyScaleY: 1,
                faceOffsetX: 0,
                faceScaleY: 1,
                sparkles: state == .thinking
                    ? Array(repeating: Sparkle(opacity: 1, scale: 1, rotation: 0), count: 3)
                    : []
            )
        }

        switch state {
        case .still:
            return frame(for: state, timestamp: nil)
        case .idle:
            let breathing = easedPulse(timestamp, duration: 3.5)
            return Self(
                bodyScaleX: 1 + 0.02 * breathing,
                bodyScaleY: 1 + 0.02 * breathing,
                faceOffsetX: 0,
                faceScaleY: blinkScale(timestamp),
                sparkles: []
            )
        case .thinking:
            let squish = easedPulse(timestamp, duration: 1.1)
            return Self(
                bodyScaleX: 1 + 0.06 * squish,
                bodyScaleY: 1 - 0.06 * squish,
                faceOffsetX: lookOffset(timestamp),
                faceScaleY: 1,
                sparkles: [0.0, 0.45, 0.9].map { sparkle(timestamp, delay: $0) }
            )
        }
    }

    private static func easedPulse(_ timestamp: TimeInterval, duration: TimeInterval) -> CGFloat {
        let phase = positiveRemainder(timestamp, duration) / duration
        return CGFloat(0.5 - 0.5 * cos(phase * 2 * .pi))
    }

    private static func blinkScale(_ timestamp: TimeInterval) -> CGFloat {
        let phase = positiveRemainder(timestamp, 4.5) / 4.5
        if phase < 0.92 { return 1 }
        if phase < 0.95 {
            return interpolate(from: 1, to: 0.08, progress: (phase - 0.92) / 0.03)
        }
        return interpolate(from: 0.08, to: 1, progress: (phase - 0.95) / 0.05)
    }

    private static func lookOffset(_ timestamp: TimeInterval) -> CGFloat {
        let phase = positiveRemainder(timestamp, 2.4) / 2.4
        if phase < 0.35 {
            return interpolate(from: 0, to: -2, progress: phase / 0.35)
        }
        if phase < 0.65 {
            return interpolate(from: -2, to: 2, progress: (phase - 0.35) / 0.30)
        }
        return interpolate(from: 2, to: 0, progress: (phase - 0.65) / 0.35)
    }

    private static func sparkle(_ timestamp: TimeInterval, delay: TimeInterval) -> Sparkle {
        let phase = positiveRemainder(timestamp - delay, 1.3) / 1.3
        let amount = CGFloat(sin(phase * .pi))
        return Sparkle(
            opacity: Double(amount),
            scale: 0.3 + 0.7 * amount,
            rotation: .pi / 2 * amount
        )
    }

    private static func interpolate(from: CGFloat, to: CGFloat, progress: TimeInterval) -> CGFloat {
        let eased = 0.5 - 0.5 * cos(progress * .pi)
        return from + (to - from) * CGFloat(eased)
    }

    private static func positiveRemainder(_ value: TimeInterval, _ divisor: TimeInterval) -> TimeInterval {
        let result = value.truncatingRemainder(dividingBy: divisor)
        return result >= 0 ? result : result + divisor
    }
}

private enum CompanionAvatarRenderer {
    private static let viewBox = CGSize(width: 64, height: 68)
    private static let faceCenterY: CGFloat = 34
    private static let bodyCenter = CGPoint(x: 32, y: 34)
    private static let ink = CompanionRGB(red: 16, green: 16, blue: 20).color
    private static let gold = CompanionRGB(red: 242, green: 176, blue: 30).color
    private static let pink = CompanionRGB(red: 224, green: 85, blue: 159).color
    private static let gray = CompanionRGB(red: 154, green: 160, blue: 166).color

    static func draw(
        configuration: CompanionAvatarConfiguration,
        state: CompanionAvatarState,
        motion: CompanionAvatarMotion,
        in canvasSize: CGSize,
        context: inout GraphicsContext
    ) {
        let scale = min(canvasSize.width / viewBox.width, canvasSize.height / viewBox.height)
        let viewTransform = CGAffineTransform(
            a: scale,
            b: 0,
            c: 0,
            d: scale,
            tx: (canvasSize.width - viewBox.width * scale) / 2,
            ty: (canvasSize.height - viewBox.height * scale) / 2
        )
        let bodyTransform = scaleTransform(
            x: motion.bodyScaleX,
            y: motion.bodyScaleY,
            around: bodyCenter
        )
        let faceTransform = CGAffineTransform(
            a: 1,
            b: 0,
            c: 0,
            d: motion.faceScaleY,
            tx: motion.faceOffsetX,
            ty: faceCenterY * (1 - motion.faceScaleY)
        )
        let bodyPath = CompanionAvatarCatalog.bodyPaths[configuration.shape]
            .applying(bodyTransform)
            .applying(viewTransform)

        drawAccessory(
            configuration.accessory,
            bodyTransform: bodyTransform,
            viewTransform: viewTransform,
            scale: scale,
            context: &context
        )
        fillBody(bodyPath, color: configuration.color, context: &context)
        drawFace(
            configuration.mouth,
            faceTransform: faceTransform,
            bodyTransform: bodyTransform,
            viewTransform: viewTransform,
            scale: scale,
            context: &context
        )

        if state == .thinking {
            drawSparkles(motion.sparkles, viewTransform: viewTransform, context: &context)
        }
    }

    private static func fillBody(
        _ path: Path,
        color: CompanionAvatarColor,
        context: inout GraphicsContext
    ) {
        let bounds = path.boundingRect
        guard bounds.width > 0, bounds.height > 0 else { return }

        var gradientContext = context
        gradientContext.clip(to: path)
        gradientContext.concatenate(
            CGAffineTransform(
                a: bounds.width,
                b: 0,
                c: 0,
                d: bounds.height,
                tx: bounds.minX,
                ty: bounds.minY
            )
        )
        let gradient = Gradient(stops: [
            .init(color: color.base.lightened(by: 55), location: 0),
            .init(color: color.base.color, location: 0.55),
            .init(color: color.shadow.color, location: 1),
        ])
        gradientContext.fill(
            Path(CGRect(x: -1, y: -1, width: 3, height: 3)),
            with: .radialGradient(
                gradient,
                center: CGPoint(x: 0.35, y: 0.28),
                startRadius: 0,
                endRadius: 0.85
            )
        )
    }

    private static func drawFace(
        _ mouth: Int,
        faceTransform: CGAffineTransform,
        bodyTransform: CGAffineTransform,
        viewTransform: CGAffineTransform,
        scale: CGFloat,
        context: inout GraphicsContext
    ) {
        func transformed(_ path: Path) -> Path {
            path.applying(faceTransform).applying(bodyTransform).applying(viewTransform)
        }

        context.fill(transformed(CompanionAvatarCatalog.leftEye), with: .color(ink))
        context.fill(transformed(CompanionAvatarCatalog.rightEye), with: .color(ink))

        switch mouth {
        case 0:
            break
        case 2:
            context.fill(transformed(CompanionAvatarCatalog.ohMouth), with: .color(ink))
        case 4:
            context.fill(transformed(CompanionAvatarCatalog.grinMouth), with: .color(ink))
        case 3:
            context.stroke(
                transformed(CompanionAvatarCatalog.catMouth),
                with: .color(ink),
                style: StrokeStyle(lineWidth: 2.2 * scale, lineCap: .round, lineJoin: .round)
            )
        default:
            context.stroke(
                transformed(CompanionAvatarCatalog.smileMouth),
                with: .color(ink),
                style: StrokeStyle(lineWidth: 2.4 * scale, lineCap: .round, lineJoin: .round)
            )
        }
    }

    private static func drawAccessory(
        _ accessory: Int,
        bodyTransform: CGAffineTransform,
        viewTransform: CGAffineTransform,
        scale: CGFloat,
        context: inout GraphicsContext
    ) {
        func transformed(_ path: Path) -> Path {
            path.applying(bodyTransform).applying(viewTransform)
        }

        switch accessory {
        case 1:
            context.stroke(
                transformed(CompanionAvatarCatalog.antennaStem),
                with: .color(gold),
                style: StrokeStyle(lineWidth: 2.4 * scale, lineCap: .round)
            )
            context.fill(transformed(CompanionAvatarCatalog.antennaTip), with: .color(gold))
        case 2:
            context.stroke(
                transformed(CompanionAvatarCatalog.halo),
                with: .color(gold),
                style: StrokeStyle(lineWidth: 2.6 * scale)
            )
        case 3:
            context.fill(transformed(CompanionAvatarCatalog.crown), with: .color(gold))
        case 4:
            context.fill(transformed(CompanionAvatarCatalog.bow), with: .color(pink))
            context.fill(transformed(CompanionAvatarCatalog.bowKnot), with: .color(pink))
        case 5:
            context.stroke(
                transformed(CompanionAvatarCatalog.headphoneBand),
                with: .color(gray),
                style: StrokeStyle(lineWidth: 3.4 * scale)
            )
            context.fill(transformed(CompanionAvatarCatalog.leftHeadphone), with: .color(gray))
            context.fill(transformed(CompanionAvatarCatalog.rightHeadphone), with: .color(gray))
        case 6:
            context.fill(transformed(CompanionAvatarCatalog.accessoryStar), with: .color(gold))
        default:
            break
        }
    }

    private static func drawSparkles(
        _ motion: [CompanionAvatarMotion.Sparkle],
        viewTransform: CGAffineTransform,
        context: inout GraphicsContext
    ) {
        for (index, path) in CompanionAvatarCatalog.thinkingSparkles.enumerated() {
            guard motion.indices.contains(index) else { continue }
            let frame = motion[index]
            let center = CompanionAvatarCatalog.thinkingSparkleCenters[index]
            let localTransform = rotationScaleTransform(
                scale: frame.scale,
                rotation: frame.rotation,
                around: center
            )
            var sparkleContext = context
            sparkleContext.opacity = frame.opacity
            sparkleContext.fill(
                path.applying(localTransform).applying(viewTransform),
                with: .color(index == 1 ? pink : gold)
            )
        }
    }

    private static func scaleTransform(x: CGFloat, y: CGFloat, around center: CGPoint) -> CGAffineTransform {
        CGAffineTransform(
            a: x,
            b: 0,
            c: 0,
            d: y,
            tx: center.x * (1 - x),
            ty: center.y * (1 - y)
        )
    }

    private static func rotationScaleTransform(
        scale: CGFloat,
        rotation: CGFloat,
        around center: CGPoint
    ) -> CGAffineTransform {
        let cosine = cos(rotation) * scale
        let sine = sin(rotation) * scale
        return CGAffineTransform(
            a: cosine,
            b: sine,
            c: -sine,
            d: cosine,
            tx: center.x - cosine * center.x + sine * center.y,
            ty: center.y - sine * center.x - cosine * center.y
        )
    }
}

private enum CompanionAvatarCatalog {
    static let colors: [CompanionAvatarColor] = [
        .init(base: .init(red: 242, green: 242, blue: 240), shadow: .init(red: 207, green: 207, blue: 201)),
        .init(base: .init(red: 138, green: 106, blue: 79), shadow: .init(red: 107, green: 79, blue: 55)),
        .init(base: .init(red: 224, green: 75, blue: 68), shadow: .init(red: 194, green: 53, blue: 48)),
        .init(base: .init(red: 240, green: 138, blue: 36), shadow: .init(red: 219, green: 110, blue: 13)),
        .init(base: .init(red: 242, green: 176, blue: 30), shadow: .init(red: 222, green: 148, blue: 16)),
        .init(base: .init(red: 63, green: 169, blue: 92), shadow: .init(red: 46, green: 138, blue: 71)),
        .init(base: .init(red: 47, green: 169, blue: 140), shadow: .init(red: 34, green: 134, blue: 110)),
        .init(base: .init(red: 61, green: 123, blue: 242), shadow: .init(red: 42, green: 95, blue: 208)),
        .init(base: .init(red: 139, green: 92, blue: 246), shadow: .init(red: 111, green: 63, blue: 224)),
        .init(base: .init(red: 224, green: 85, blue: 159), shadow: .init(red: 201, green: 59, blue: 132)),
        .init(base: .init(red: 154, green: 160, blue: 166), shadow: .init(red: 126, green: 132, blue: 139)),
    ]

    static let bodyPaths: [Path] = [
        Path(ellipseIn: CGRect(x: 6, y: 6, width: 52, height: 52)),
        Path { path in
            path.move(to: CGPoint(x: 32, y: 5))
            path.addCurve(
                to: CGPoint(x: 6, y: 29),
                control1: CGPoint(x: 17, y: 5),
                control2: CGPoint(x: 6, y: 15)
            )
            path.addCurve(
                to: CGPoint(x: 28, y: 51),
                control1: CGPoint(x: 6, y: 41),
                control2: CGPoint(x: 15, y: 51)
            )
            path.addCurve(
                to: CGPoint(x: 54, y: 30),
                control1: CGPoint(x: 42, y: 51),
                control2: CGPoint(x: 54, y: 43)
            )
            path.addCurve(
                to: CGPoint(x: 32, y: 5),
                control1: CGPoint(x: 54, y: 17),
                control2: CGPoint(x: 45, y: 5)
            )
            path.closeSubpath()
        },
        Path(CGPath(
            roundedRect: CGRect(x: 7, y: 7, width: 50, height: 50),
            cornerWidth: 13,
            cornerHeight: 13,
            transform: nil
        )),
        Path(CGPath(
            roundedRect: CGRect(x: 1, y: 8, width: 62, height: 48),
            cornerWidth: 24,
            cornerHeight: 24,
            transform: nil
        )),
        roundedTriangle,
        roundedHexagon,
        Path { path in
            path.move(to: CGPoint(x: 20, y: 54))
            path.addCurve(
                to: CGPoint(x: 5, y: 41),
                control1: CGPoint(x: 11, y: 54),
                control2: CGPoint(x: 5, y: 48)
            )
            path.addCurve(
                to: CGPoint(x: 15, y: 28),
                control1: CGPoint(x: 5, y: 35),
                control2: CGPoint(x: 9, y: 30)
            )
            path.addCurve(
                to: CGPoint(x: 33, y: 10),
                control1: CGPoint(x: 16, y: 18),
                control2: CGPoint(x: 23, y: 10)
            )
            path.addCurve(
                to: CGPoint(x: 51, y: 24),
                control1: CGPoint(x: 42, y: 10),
                control2: CGPoint(x: 49, y: 16)
            )
            path.addLine(to: CGPoint(x: 54, y: 24))
            path.addCurve(
                to: CGPoint(x: 63, y: 36),
                control1: CGPoint(x: 59, y: 24),
                control2: CGPoint(x: 63, y: 29)
            )
            path.addCurve(
                to: CGPoint(x: 46, y: 54),
                control1: CGPoint(x: 63, y: 46),
                control2: CGPoint(x: 56, y: 54)
            )
            path.addLine(to: CGPoint(x: 20, y: 54))
            path.closeSubpath()
        },
        Path { path in
            path.move(to: CGPoint(x: 32, y: 4))
            path.addCurve(
                to: CGPoint(x: 12, y: 39),
                control1: CGPoint(x: 22, y: 18),
                control2: CGPoint(x: 12, y: 28)
            )
            appendSVGArc(
                to: &path,
                from: CGPoint(x: 12, y: 39),
                to: CGPoint(x: 52, y: 39),
                radiusX: 20,
                radiusY: 20,
                largeArc: false,
                sweep: false
            )
            path.addCurve(
                to: CGPoint(x: 32, y: 4),
                control1: CGPoint(x: 52, y: 28),
                control2: CGPoint(x: 42, y: 18)
            )
            path.closeSubpath()
        },
    ]

    static let leftEye = Path(ellipseIn: CGRect(x: 23.4, y: 25.6, width: 5.2, height: 8.8))
    static let rightEye = Path(ellipseIn: CGRect(x: 35.4, y: 25.6, width: 5.2, height: 8.8))
    static let ohMouth = Path(ellipseIn: CGRect(x: 29, y: 35, width: 6, height: 8))
    static let smileMouth = Path { path in
        path.move(to: CGPoint(x: 27, y: 38))
        path.addQuadCurve(to: CGPoint(x: 37, y: 38), control: CGPoint(x: 32, y: 43))
    }
    static let catMouth = Path { path in
        path.move(to: CGPoint(x: 27, y: 38))
        path.addQuadCurve(to: CGPoint(x: 32, y: 38), control: CGPoint(x: 29.5, y: 41))
        path.addQuadCurve(to: CGPoint(x: 37, y: 38), control: CGPoint(x: 34.5, y: 41))
    }
    static let grinMouth = Path { path in
        path.move(to: CGPoint(x: 26, y: 37))
        path.addLine(to: CGPoint(x: 38, y: 37))
        path.addQuadCurve(to: CGPoint(x: 32, y: 43), control: CGPoint(x: 37, y: 43))
        path.addQuadCurve(to: CGPoint(x: 26, y: 37), control: CGPoint(x: 27, y: 43))
        path.closeSubpath()
    }

    static let antennaStem = Path { path in
        path.move(to: CGPoint(x: 32, y: 8))
        path.addLine(to: CGPoint(x: 36, y: 2))
    }
    static let antennaTip = Path(ellipseIn: CGRect(x: 34, y: -1, width: 6, height: 6))
    static let halo = Path(ellipseIn: CGRect(x: 20, y: 0.5, width: 24, height: 7))
    static let crown = Path { path in
        path.move(to: CGPoint(x: 20, y: 8))
        path.addLine(to: CGPoint(x: 24, y: 1))
        path.addLine(to: CGPoint(x: 32, y: 6))
        path.addLine(to: CGPoint(x: 40, y: 1))
        path.addLine(to: CGPoint(x: 44, y: 8))
        path.closeSubpath()
    }
    static let bow = Path { path in
        path.move(to: CGPoint(x: 46, y: 12))
        path.addLine(to: CGPoint(x: 56, y: 7))
        path.addLine(to: CGPoint(x: 56, y: 17))
        path.closeSubpath()
    }
    static let bowKnot = Path(ellipseIn: CGRect(x: 42.4, y: 9.4, width: 5.2, height: 5.2))
    static let headphoneBand = Path { path in
        path.move(to: CGPoint(x: 12, y: 30))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 12, y: 30),
            to: CGPoint(x: 52, y: 30),
            radiusX: 20,
            radiusY: 20,
            largeArc: false,
            sweep: true
        )
    }
    static let leftHeadphone = Path(CGPath(
        roundedRect: CGRect(x: 8, y: 28, width: 7, height: 12),
        cornerWidth: 3.5,
        cornerHeight: 3.5,
        transform: nil
    ))
    static let rightHeadphone = Path(CGPath(
        roundedRect: CGRect(x: 49, y: 28, width: 7, height: 12),
        cornerWidth: 3.5,
        cornerHeight: 3.5,
        transform: nil
    ))
    static let accessoryStar = Path { path in
        path.move(to: CGPoint(x: 54, y: 4))
        path.addLine(to: CGPoint(x: 55.6, y: 7.6))
        path.addLine(to: CGPoint(x: 59, y: 9))
        path.addLine(to: CGPoint(x: 55.6, y: 10.4))
        path.addLine(to: CGPoint(x: 54, y: 14))
        path.addLine(to: CGPoint(x: 52.4, y: 10.4))
        path.addLine(to: CGPoint(x: 49, y: 9))
        path.addLine(to: CGPoint(x: 52.4, y: 7.6))
        path.closeSubpath()
    }

    static let thinkingSparkles: [Path] = [
        Path { path in
            path.move(to: CGPoint(x: 50, y: 14))
            path.addLine(to: CGPoint(x: 51.4, y: 17.2))
            path.addLine(to: CGPoint(x: 54.6, y: 18))
            path.addLine(to: CGPoint(x: 51.4, y: 19.4))
            path.addLine(to: CGPoint(x: 50, y: 23))
            path.addLine(to: CGPoint(x: 48.6, y: 19.4))
            path.addLine(to: CGPoint(x: 45.4, y: 18))
            path.addLine(to: CGPoint(x: 48.6, y: 17.2))
            path.closeSubpath()
        },
        Path { path in
            path.move(to: CGPoint(x: 57, y: 26))
            path.addLine(to: CGPoint(x: 58, y: 28.4))
            path.addLine(to: CGPoint(x: 60.4, y: 29.4))
            path.addLine(to: CGPoint(x: 58, y: 30.4))
            path.addLine(to: CGPoint(x: 57, y: 32.8))
            path.addLine(to: CGPoint(x: 56, y: 30.4))
            path.addLine(to: CGPoint(x: 53.6, y: 29.4))
            path.addLine(to: CGPoint(x: 56, y: 28.4))
            path.closeSubpath()
        },
        Path { path in
            path.move(to: CGPoint(x: 12, y: 12))
            path.addLine(to: CGPoint(x: 13, y: 14.4))
            path.addLine(to: CGPoint(x: 15.4, y: 15.4))
            path.addLine(to: CGPoint(x: 13, y: 16.4))
            path.addLine(to: CGPoint(x: 12, y: 18.8))
            path.addLine(to: CGPoint(x: 11, y: 16.4))
            path.addLine(to: CGPoint(x: 8.6, y: 15.4))
            path.addLine(to: CGPoint(x: 11, y: 14.4))
            path.closeSubpath()
        },
    ]
    static let thinkingSparkleCenters = [
        CGPoint(x: 50, y: 18.5),
        CGPoint(x: 57, y: 29.4),
        CGPoint(x: 12, y: 15.4),
    ]

    private static let roundedTriangle = Path { path in
        path.move(to: CGPoint(x: 27, y: 9))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 27, y: 9),
            to: CGPoint(x: 37, y: 9),
            radiusX: 6,
            radiusY: 6,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 56, y: 42))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 56, y: 42),
            to: CGPoint(x: 51, y: 51),
            radiusX: 6,
            radiusY: 6,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 13, y: 51))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 13, y: 51),
            to: CGPoint(x: 8, y: 42),
            radiusX: 6,
            radiusY: 6,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 27, y: 9))
        path.closeSubpath()
    }

    private static let roundedHexagon = Path { path in
        path.move(to: CGPoint(x: 28, y: 6))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 28, y: 6),
            to: CGPoint(x: 36, y: 6),
            radiusX: 8,
            radiusY: 8,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 53, y: 16))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 53, y: 16),
            to: CGPoint(x: 57, y: 23),
            radiusX: 8,
            radiusY: 8,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 57, y: 43))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 57, y: 43),
            to: CGPoint(x: 53, y: 50),
            radiusX: 8,
            radiusY: 8,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 36, y: 60))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 36, y: 60),
            to: CGPoint(x: 28, y: 60),
            radiusX: 8,
            radiusY: 8,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 11, y: 50))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 11, y: 50),
            to: CGPoint(x: 7, y: 43),
            radiusX: 8,
            radiusY: 8,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 7, y: 23))
        appendSVGArc(
            to: &path,
            from: CGPoint(x: 7, y: 23),
            to: CGPoint(x: 11, y: 16),
            radiusX: 8,
            radiusY: 8,
            largeArc: false,
            sweep: true
        )
        path.addLine(to: CGPoint(x: 28, y: 6))
        path.closeSubpath()
    }

    /// Converts the SVG endpoint arc command used by the web catalog into cubic Core Graphics
    /// segments. The catalog currently uses circular, zero-rotation arcs, but the complete formula
    /// keeps the client faithful if those fixed paths gain elliptical arcs later.
    private static func appendSVGArc(
        to path: inout Path,
        from start: CGPoint,
        to end: CGPoint,
        radiusX requestedRadiusX: CGFloat,
        radiusY requestedRadiusY: CGFloat,
        rotation: CGFloat = 0,
        largeArc: Bool,
        sweep: Bool
    ) {
        guard start != end else { return }
        var radiusX = abs(requestedRadiusX)
        var radiusY = abs(requestedRadiusY)
        guard radiusX > 0, radiusY > 0 else {
            path.addLine(to: end)
            return
        }

        let cosine = cos(rotation)
        let sine = sin(rotation)
        let deltaX = (start.x - end.x) / 2
        let deltaY = (start.y - end.y) / 2
        let transformedX = cosine * deltaX + sine * deltaY
        let transformedY = -sine * deltaX + cosine * deltaY
        let radiusScale = transformedX * transformedX / (radiusX * radiusX)
            + transformedY * transformedY / (radiusY * radiusY)
        if radiusScale > 1 {
            let multiplier = sqrt(radiusScale)
            radiusX *= multiplier
            radiusY *= multiplier
        }

        let radiusXSquared = radiusX * radiusX
        let radiusYSquared = radiusY * radiusY
        let transformedXSquared = transformedX * transformedX
        let transformedYSquared = transformedY * transformedY
        let numerator = max(
            0,
            radiusXSquared * radiusYSquared
                - radiusXSquared * transformedYSquared
                - radiusYSquared * transformedXSquared
        )
        let denominator = radiusXSquared * transformedYSquared
            + radiusYSquared * transformedXSquared
        let sign: CGFloat = largeArc == sweep ? -1 : 1
        let coefficient = denominator == 0 ? 0 : sign * sqrt(numerator / denominator)
        let centerTransformedX = coefficient * radiusX * transformedY / radiusY
        let centerTransformedY = coefficient * -radiusY * transformedX / radiusX
        let center = CGPoint(
            x: cosine * centerTransformedX - sine * centerTransformedY + (start.x + end.x) / 2,
            y: sine * centerTransformedX + cosine * centerTransformedY + (start.y + end.y) / 2
        )

        let startVector = CGPoint(
            x: (transformedX - centerTransformedX) / radiusX,
            y: (transformedY - centerTransformedY) / radiusY
        )
        let endVector = CGPoint(
            x: (-transformedX - centerTransformedX) / radiusX,
            y: (-transformedY - centerTransformedY) / radiusY
        )
        var startAngle = vectorAngle(from: CGPoint(x: 1, y: 0), to: startVector)
        var deltaAngle = vectorAngle(from: startVector, to: endVector)
        if !sweep, deltaAngle > 0 { deltaAngle -= 2 * .pi }
        if sweep, deltaAngle < 0 { deltaAngle += 2 * .pi }

        let segmentCount = max(1, Int(ceil(abs(deltaAngle) / (.pi / 2))))
        let segmentAngle = deltaAngle / CGFloat(segmentCount)
        for _ in 0..<segmentCount {
            let endAngle = startAngle + segmentAngle
            let startPoint = ellipsePoint(
                angle: startAngle,
                center: center,
                radiusX: radiusX,
                radiusY: radiusY,
                cosine: cosine,
                sine: sine
            )
            let endPoint = ellipsePoint(
                angle: endAngle,
                center: center,
                radiusX: radiusX,
                radiusY: radiusY,
                cosine: cosine,
                sine: sine
            )
            let startDerivative = ellipseDerivative(
                angle: startAngle,
                radiusX: radiusX,
                radiusY: radiusY,
                cosine: cosine,
                sine: sine
            )
            let endDerivative = ellipseDerivative(
                angle: endAngle,
                radiusX: radiusX,
                radiusY: radiusY,
                cosine: cosine,
                sine: sine
            )
            let alpha = 4 / 3 * tan(segmentAngle / 4)
            path.addCurve(
                to: endPoint,
                control1: CGPoint(
                    x: startPoint.x + alpha * startDerivative.x,
                    y: startPoint.y + alpha * startDerivative.y
                ),
                control2: CGPoint(
                    x: endPoint.x - alpha * endDerivative.x,
                    y: endPoint.y - alpha * endDerivative.y
                )
            )
            startAngle = endAngle
        }
    }

    private static func vectorAngle(from first: CGPoint, to second: CGPoint) -> CGFloat {
        atan2(first.x * second.y - first.y * second.x, first.x * second.x + first.y * second.y)
    }

    private static func ellipsePoint(
        angle: CGFloat,
        center: CGPoint,
        radiusX: CGFloat,
        radiusY: CGFloat,
        cosine: CGFloat,
        sine: CGFloat
    ) -> CGPoint {
        CGPoint(
            x: center.x + radiusX * cosine * cos(angle) - radiusY * sine * sin(angle),
            y: center.y + radiusX * sine * cos(angle) + radiusY * cosine * sin(angle)
        )
    }

    private static func ellipseDerivative(
        angle: CGFloat,
        radiusX: CGFloat,
        radiusY: CGFloat,
        cosine: CGFloat,
        sine: CGFloat
    ) -> CGPoint {
        CGPoint(
            x: -radiusX * cosine * sin(angle) - radiusY * sine * cos(angle),
            y: -radiusX * sine * sin(angle) + radiusY * cosine * cos(angle)
        )
    }
}
