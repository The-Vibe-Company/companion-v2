#if canImport(SwiftUI)
import SwiftUI

/// A vector Companion identity mark: one approved shape, one approved color, and two white
/// eyes. Legacy mouth and accessory fields remain transport-compatible but are never rendered.
public struct CharacterMark: View {
    public let name: String
    public let shapeIndex: Int
    public let colorIndex: Int
    public let size: CGFloat

    public init(
        name: String,
        icon: CompanionSummary.Icon?,
        size: CGFloat
    ) {
        self.init(
            name: name,
            shapeIndex: icon?.shape ?? CharacterMarkGeometry.defaultShapeIndex,
            colorIndex: icon?.color ?? CharacterMarkGeometry.defaultColorIndex,
            size: size
        )
    }

    public init(name: String, shapeIndex: Int, colorIndex: Int, size: CGFloat) {
        self.name = name
        self.shapeIndex = CharacterMarkGeometry.normalizedShapeIndex(shapeIndex)
        self.colorIndex = CharacterMarkGeometry.normalizedColorIndex(colorIndex)
        self.size = size
    }

    public var body: some View {
        Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, canvasSize in
            let side = min(canvasSize.width, canvasSize.height)
            let origin = CGPoint(
                x: (canvasSize.width - side) / 2,
                y: (canvasSize.height - side) / 2
            )
            let rect = CGRect(origin: origin, size: .init(width: side, height: side))
            context.fill(path(in: rect), with: .color(markColor))

            var eyes = Path()
            for eye in CharacterMarkGeometry.eyeSegments {
                eyes.move(to: point(eye.start, in: origin, side: side))
                eyes.addLine(to: point(eye.end, in: origin, side: side))
            }
            context.stroke(
                eyes,
                with: .color(.white),
                style: StrokeStyle(lineWidth: side * 0.075, lineCap: .round)
            )
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name), Companion character")
    }

    /// The palette is public so native creation galleries can use the exact same colors as the
    /// renderer without maintaining an app-local swatch list.
    public static let palette = CompanionIOSTheme.characterMarkPalette

    private var markColor: Color {
        Self.palette[colorIndex]
    }

    private func path(in rect: CGRect) -> Path {
        var path = Path()
        for command in CharacterMarkGeometry.commands(shapeIndex: shapeIndex) {
            switch command {
            case .move(let point): path.move(to: scaled(point, in: rect))
            case .line(let point): path.addLine(to: scaled(point, in: rect))
            case .curve(let first, let second, let end):
                path.addCurve(
                    to: scaled(end, in: rect),
                    control1: scaled(first, in: rect),
                    control2: scaled(second, in: rect)
                )
            case .close: path.closeSubpath()
            }
        }
        return path
    }

    private func scaled(_ point: CharacterMarkPoint, in rect: CGRect) -> CGPoint {
        CGPoint(x: rect.minX + point.x * rect.width, y: rect.minY + point.y * rect.height)
    }

    private func point(_ point: CharacterMarkPoint, in origin: CGPoint, side: CGFloat) -> CGPoint {
        CGPoint(x: origin.x + point.x * side, y: origin.y + point.y * side)
    }
}
#endif
