import Foundation

/// Normalized vector geometry shared by the SwiftUI CharacterMark renderer and deterministic tests.
public enum CharacterMarkShape: Int, CaseIterable, Sendable {
    case circle
    case blob
    case squircle
    case capsule
    case triangle
    case hexagon
    case flower
    case drop
}

public struct CharacterMarkPoint: Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }
}

public enum CharacterMarkPathCommand: Equatable, Sendable {
    case move(CharacterMarkPoint)
    case line(CharacterMarkPoint)
    case curve(CharacterMarkPoint, CharacterMarkPoint, CharacterMarkPoint)
    case close
}

public enum CharacterMarkGeometry {
    public static let supportedSizes = [20, 36, 64, 80, 96]

    /// The transport keeps the original icon indexes, but native rendering has one stable
    /// fallback for values from older or malformed projections.
    public static let defaultShapeIndex = CharacterMarkShape.blob.rawValue
    public static let defaultColorIndex = 2

    public static func normalizedShapeIndex(_ value: Int) -> Int {
        CharacterMarkShape(rawValue: value)?.rawValue ?? defaultShapeIndex
    }

    public static func normalizedColorIndex(_ value: Int) -> Int {
        CompanionAppearancePalette.characterMarks.indices.contains(value)
            ? value
            : defaultColorIndex
    }

    public static let eyeSegments: [(start: CharacterMarkPoint, end: CharacterMarkPoint)] = [
        (.init(0.385, 0.375), .init(0.425, 0.285)),
        (.init(0.555, 0.375), .init(0.595, 0.285)),
    ]

    public static func commands(shapeIndex: Int) -> [CharacterMarkPathCommand] {
        let shape = CharacterMarkShape(rawValue: shapeIndex) ?? .blob
        switch shape {
        case .circle:
            return roundedRectangle(x: 0.04, y: 0.04, width: 0.92, height: 0.92, radius: 0.46)
        case .blob:
            return [
                .move(.init(0.52, 0.04)),
                .curve(.init(0.80, 0.01), .init(0.99, 0.23), .init(0.94, 0.54)),
                .curve(.init(0.91, 0.84), .init(0.69, 1.00), .init(0.37, 0.95)),
                .curve(.init(0.09, 0.91), .init(0.00, 0.65), .init(0.06, 0.35)),
                .curve(.init(0.12, 0.11), .init(0.29, 0.06), .init(0.52, 0.04)),
                .close,
            ]
        case .squircle:
            return roundedRectangle(x: 0.04, y: 0.04, width: 0.92, height: 0.92, radius: 0.24)
        case .capsule:
            return roundedRectangle(x: 0.15, y: 0.03, width: 0.70, height: 0.94, radius: 0.35)
        case .triangle:
            return polygon([.init(0.50, 0.04), .init(0.97, 0.94), .init(0.03, 0.94)])
        case .hexagon:
            return polygon([
                .init(0.27, 0.04), .init(0.73, 0.04), .init(0.97, 0.50),
                .init(0.73, 0.96), .init(0.27, 0.96), .init(0.03, 0.50),
            ])
        case .flower:
            return [
                .move(.init(0.50, 0.11)),
                .curve(.init(0.62, 0.00), .init(0.80, 0.07), .init(0.79, 0.23)),
                .curve(.init(0.98, 0.20), .init(1.00, 0.40), .init(0.89, 0.50)),
                .curve(.init(1.00, 0.62), .init(0.94, 0.83), .init(0.78, 0.78)),
                .curve(.init(0.78, 0.98), .init(0.57, 1.00), .init(0.49, 0.88)),
                .curve(.init(0.37, 1.00), .init(0.17, 0.94), .init(0.22, 0.77)),
                .curve(.init(0.03, 0.78), .init(0.00, 0.57), .init(0.12, 0.49)),
                .curve(.init(0.00, 0.36), .init(0.08, 0.16), .init(0.24, 0.22)),
                .curve(.init(0.23, 0.05), .init(0.43, 0.00), .init(0.50, 0.11)),
                .close,
            ]
        case .drop:
            return [
                .move(.init(0.50, 0.02)),
                .curve(.init(0.50, 0.02), .init(0.93, 0.50), .init(0.93, 0.70)),
                .curve(.init(0.93, 0.91), .init(0.74, 1.00), .init(0.50, 1.00)),
                .curve(.init(0.26, 1.00), .init(0.07, 0.91), .init(0.07, 0.70)),
                .curve(.init(0.07, 0.48), .init(0.50, 0.02), .init(0.50, 0.02)),
                .close,
            ]
        }
    }

    private static func polygon(_ points: [CharacterMarkPoint]) -> [CharacterMarkPathCommand] {
        guard let first = points.first else { return [] }
        return [.move(first)] + points.dropFirst().map(CharacterMarkPathCommand.line) + [.close]
    }

    private static func roundedRectangle(
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        radius: Double
    ) -> [CharacterMarkPathCommand] {
        let right = x + width
        let bottom = y + height
        let control = radius * 0.552_284_749_8
        return [
            .move(.init(x + radius, y)),
            .line(.init(right - radius, y)),
            .curve(.init(right - radius + control, y), .init(right, y + radius - control), .init(right, y + radius)),
            .line(.init(right, bottom - radius)),
            .curve(.init(right, bottom - radius + control), .init(right - radius + control, bottom), .init(right - radius, bottom)),
            .line(.init(x + radius, bottom)),
            .curve(.init(x + radius - control, bottom), .init(x, bottom - radius + control), .init(x, bottom - radius)),
            .line(.init(x, y + radius)),
            .curve(.init(x, y + radius - control), .init(x + radius - control, y), .init(x + radius, y)),
            .close,
        ]
    }
}
