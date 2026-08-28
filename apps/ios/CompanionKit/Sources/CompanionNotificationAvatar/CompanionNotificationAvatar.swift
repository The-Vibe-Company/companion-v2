@preconcurrency import CoreGraphics
import CompanionKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The CharacterMark fields carried by a reply notification.
///
/// Legacy mouth and accessory values may still be present in the payload for transport
/// compatibility, but the approved character renderer deliberately projects only shape and color.
public struct CompanionNotificationMark: Equatable, Hashable, Sendable {
    public static let shapeCount = CharacterMarkShape.allCases.count
    public static let colorCount = CompanionAppearancePalette.characterMarks.count
    public static let defaultMark = Self(shape: CharacterMarkShape.blob.rawValue, color: 2)

    public let shape: Int
    public let color: Int

    public init(shape: Int, color: Int) {
        self.shape = shape
        self.color = color
    }

    /// Projects the mark from APNs' nested `companion_icon` dictionary.
    public init?(apnsUserInfo userInfo: [AnyHashable: Any]) {
        guard let values = Self.dictionaryValue(userInfo["companion_icon"]),
              let shape = Self.integer(values["shape"]),
              (0..<Self.shapeCount).contains(shape),
              let color = Self.integer(values["color"]),
              (0..<Self.colorCount).contains(color) else {
            return nil
        }
        self.init(shape: shape, color: color)
    }

    fileprivate var normalized: Self {
        Self(
            shape: (0..<Self.shapeCount).contains(shape) ? shape : Self.defaultMark.shape,
            color: (0..<Self.colorCount).contains(color) ? color : Self.defaultMark.color
        )
    }

    private static func dictionaryValue(_ value: Any?) -> [AnyHashable: Any]? {
        if let value = value as? [AnyHashable: Any] { return value }
        if let value = value as? [String: Any] {
            return Dictionary(uniqueKeysWithValues: value.map { (AnyHashable($0.key), $0.value) })
        }
        return nil
    }

    private static func integer(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        guard let number = value as? NSNumber else { return nil }

        // NSNumber also bridges Bool; booleans are not cosmetic indexes.
        let type = String(cString: number.objCType)
        guard type != "c", type != "B" else { return nil }

        let doubleValue = number.doubleValue
        guard doubleValue.isFinite, doubleValue.rounded() == doubleValue else { return nil }
        let integerValue = number.int64Value
        guard Double(integerValue) == doubleValue else { return nil }
        return Int(exactly: integerValue)
    }
}

/// Deterministic, network-free CharacterMark renderer used by both notification extension builds.
public enum CompanionNotificationAvatar {
    public static let defaultSize = 512
    public static let maximumSize = 2048

    public enum RenderError: Error, Equatable, Sendable {
        case invalidSize
        case bitmapContextUnavailable
        case imageUnavailable
        case pngEncodingFailed
    }

    public static func pngData(
        for mark: CompanionNotificationMark = .defaultMark,
        size: Int = Self.defaultSize
    ) throws -> Data {
        guard (1...Self.maximumSize).contains(size) else { throw RenderError.invalidSize }
        return try renderWithCoreGraphics(mark: mark.normalized, size: size)
    }
}

private extension CompanionNotificationAvatar {
    static func renderWithCoreGraphics(mark: CompanionNotificationMark, size: Int) throws -> Data {
        guard let context = CGContext(
            data: nil,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: size * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw RenderError.bitmapContextUnavailable
        }

        context.setAllowsAntialiasing(true)
        context.setShouldAntialias(true)
        context.interpolationQuality = .high
        context.clear(CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)))

        // Match SwiftUI Canvas' top-left coordinate space exactly.
        context.translateBy(x: 0, y: CGFloat(size))
        context.scaleBy(x: 1, y: -1)

        let side = CGFloat(size)
        context.addPath(markPath(shapeIndex: mark.shape, side: side))
        context.setFillColor(color(mark.color))
        context.fillPath()

        context.beginPath()
        for eye in CharacterMarkGeometry.eyeSegments {
            context.move(to: point(eye.start, side: side))
            context.addLine(to: point(eye.end, side: side))
        }
        context.setStrokeColor(CGColor(gray: 1, alpha: 1))
        context.setLineWidth(side * 0.075)
        context.setLineCap(.round)
        context.strokePath()

        guard let image = context.makeImage() else { throw RenderError.imageUnavailable }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output as CFMutableData,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw RenderError.pngEncodingFailed
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw RenderError.pngEncodingFailed }
        return output as Data
    }

    static func markPath(shapeIndex: Int, side: CGFloat) -> CGPath {
        let path = CGMutablePath()
        for command in CharacterMarkGeometry.commands(shapeIndex: shapeIndex) {
            switch command {
            case .move(let point):
                path.move(to: Self.point(point, side: side))
            case .line(let point):
                path.addLine(to: Self.point(point, side: side))
            case .curve(let first, let second, let end):
                path.addCurve(
                    to: Self.point(end, side: side),
                    control1: Self.point(first, side: side),
                    control2: Self.point(second, side: side)
                )
            case .close:
                path.closeSubpath()
            }
        }
        return path
    }

    static func point(_ point: CharacterMarkPoint, side: CGFloat) -> CGPoint {
        CGPoint(x: CGFloat(point.x) * side, y: CGFloat(point.y) * side)
    }

    static func color(_ index: Int) -> CGColor {
        let rgb = CompanionAppearancePalette.characterMarks[index]
        return CGColor(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
