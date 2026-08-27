import SwiftUI
import CompanionKit

struct CharacterMark: View {
    let name: String
    let shapeIndex: Int
    let colorIndex: Int
    let size: CGFloat

    init(
        name: String,
        icon: CompanionSummary.Icon?,
        size: CGFloat
    ) {
        self.name = name
        shapeIndex = icon.map(\.shape) ?? CharacterMarkShape.blob.rawValue
        colorIndex = icon.map(\.color) ?? 2
        self.size = size
    }

    init(name: String, shapeIndex: Int, colorIndex: Int, size: CGFloat) {
        self.name = name
        self.shapeIndex = shapeIndex
        self.colorIndex = colorIndex
        self.size = size
    }

    var body: some View {
        Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, canvasSize in
            let side = min(canvasSize.width, canvasSize.height)
            let origin = CGPoint(
                x: (canvasSize.width - side) / 2,
                y: (canvasSize.height - side) / 2
            )
            context.fill(path(in: CGRect(origin: origin, size: .init(width: side, height: side))), with: .color(color))

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

    private var color: Color {
        Self.palette[Self.clamp(colorIndex, count: Self.palette.count, fallback: 2)]
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

    private static func clamp(_ value: Int, count: Int, fallback: Int) -> Int {
        (0..<count).contains(value) ? value : fallback
    }

    static let palette: [Color] = [
        Color(red: 0, green: 0, blue: 0),
        Color(red: 162 / 255, green: 132 / 255, blue: 94 / 255),
        Color(red: 1, green: 59 / 255, blue: 48 / 255),
        Color(red: 1, green: 149 / 255, blue: 0),
        Color(red: 1, green: 204 / 255, blue: 0),
        Color(red: 52 / 255, green: 199 / 255, blue: 89 / 255),
        Color(red: 48 / 255, green: 176 / 255, blue: 199 / 255),
        Color(red: 0, green: 122 / 255, blue: 1),
        Color(red: 175 / 255, green: 82 / 255, blue: 222 / 255),
        Color(red: 1, green: 45 / 255, blue: 85 / 255),
        Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255),
    ]
}
