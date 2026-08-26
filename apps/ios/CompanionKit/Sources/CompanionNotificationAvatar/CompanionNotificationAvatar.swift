import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The four cosmetic indexes carried by a Companion notification.
///
/// The values are deliberately kept independent from `CompanionKit`'s API models so a notification
/// service can render an avatar without loading the rest of the client or making a network request.
public struct CompanionNotificationIcon: Codable, Equatable, Hashable, Sendable {
    public static let shapeCount = 8
    public static let mouthCount = 5
    public static let accessoryCount = 7
    public static let colorCount = 11

    /// The same fallback used by the web and native Companion renderers.
    public static let defaultIcon = Self(shape: 1, mouth: 1, accessory: 1, color: 2)

    public let shape: Int
    public let mouth: Int
    public let accessory: Int
    public let color: Int

    public init(shape: Int, mouth: Int, accessory: Int, color: Int) {
        self.shape = shape
        self.mouth = mouth
        self.accessory = accessory
        self.color = color
    }

    /// Parses the cosmetic fields from an APNs `userInfo` dictionary.
    ///
    /// The fields are expected in the nested `companion_icon` dictionary. All four fields are
    /// required and must be integral numbers in their contract bounds. Missing or malformed values
    /// return `nil` rather than silently changing a Companion's appearance.
    public init?(apnsUserInfo userInfo: [AnyHashable: Any]) {
        guard let values = Self.values(from: userInfo) else { return nil }
        self.init(
            shape: values.shape,
            mouth: values.mouth,
            accessory: values.accessory,
            color: values.color
        )
    }

    fileprivate var normalized: Self {
        Self(
            shape: (0..<Self.shapeCount).contains(shape) ? shape : Self.defaultIcon.shape,
            mouth: (0..<Self.mouthCount).contains(mouth) ? mouth : Self.defaultIcon.mouth,
            accessory: (0..<Self.accessoryCount).contains(accessory) ? accessory : Self.defaultIcon.accessory,
            color: (0..<Self.colorCount).contains(color) ? color : Self.defaultIcon.color
        )
    }

    private struct Values {
        let shape: Int
        let mouth: Int
        let accessory: Int
        let color: Int
    }

    private static func values(from userInfo: [AnyHashable: Any]) -> Values? {
        for dictionary in candidateDictionaries(from: userInfo) {
            guard let shape = integer(dictionary["shape"]), (0..<Self.shapeCount).contains(shape),
                  let mouth = integer(dictionary["mouth"]), (0..<Self.mouthCount).contains(mouth),
                  let accessory = integer(dictionary["accessory"]), (0..<Self.accessoryCount).contains(accessory),
                  let color = integer(dictionary["color"]), (0..<Self.colorCount).contains(color) else {
                continue
            }
            return Values(shape: shape, mouth: mouth, accessory: accessory, color: color)
        }
        return nil
    }

    private static func candidateDictionaries(from userInfo: [AnyHashable: Any]) -> [[AnyHashable: Any]] {
        guard let nested = dictionaryValue(userInfo["companion_icon"]) else { return [] }
        return [nested]
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

        // NSNumber also represents Bool. A boolean is not a valid icon index even though its
        // numeric value could otherwise fit a catalog bound.
        let type = String(cString: number.objCType)
        guard type != "c", type != "B" else { return nil }

        let doubleValue = number.doubleValue
        guard doubleValue.isFinite, doubleValue.rounded() == doubleValue else { return nil }
        let integerValue = number.int64Value
        guard Double(integerValue) == doubleValue else { return nil }
        return Int(exactly: integerValue)
    }
}

/// Deterministic renderer for the closed Companion notification avatar catalog.
///
/// Rendering is entirely local, using a bitmap Core Graphics context and ImageIO's PNG encoder.
public enum CompanionNotificationAvatar {
    public static let defaultSize = 512
    public static let maximumSize = 2048

    public enum RenderError: Error, Equatable, Sendable {
        case invalidSize
        case bitmapContextUnavailable
        case imageUnavailable
        case pngEncodingFailed
    }

    /// Returns a PNG at `size × size` pixels. The default is suitable for notification attachments.
    public static func pngData(
        for icon: CompanionNotificationIcon = .defaultIcon,
        size: Int = Self.defaultSize
    ) throws -> Data {
        guard (1...Self.maximumSize).contains(size) else { throw RenderError.invalidSize }
        let normalized = icon.normalized

        return try renderWithCoreGraphics(icon: normalized, size: size)
    }
}

private struct CompanionAvatarColor: Equatable {
    let red: UInt8
    let green: UInt8
    let blue: UInt8
    let shadowRed: UInt8
    let shadowGreen: UInt8
    let shadowBlue: UInt8

    init(
        red: UInt8,
        green: UInt8,
        blue: UInt8,
        shadowRed: UInt8? = nil,
        shadowGreen: UInt8? = nil,
        shadowBlue: UInt8? = nil
    ) {
        self.red = red
        self.green = green
        self.blue = blue
        self.shadowRed = shadowRed ?? (red >= 30 ? red - 30 : 0)
        self.shadowGreen = shadowGreen ?? (green >= 25 ? green - 25 : 0)
        self.shadowBlue = shadowBlue ?? (blue >= 21 ? blue - 21 : 0)
    }

    func lightened(by amount: UInt8) -> Self {
        Self(
            red: UInt8(min(Int(red) + Int(amount), 255)),
            green: UInt8(min(Int(green) + Int(amount), 255)),
            blue: UInt8(min(Int(blue) + Int(amount), 255))
        )
    }

    var shadow: Self {
        Self(red: shadowRed, green: shadowGreen, blue: shadowBlue)
    }
}

private enum CompanionNotificationAvatarCatalog {
    static let colors: [CompanionAvatarColor] = [
        .init(red: 242, green: 242, blue: 240, shadowRed: 207, shadowGreen: 207, shadowBlue: 201),
        .init(red: 138, green: 106, blue: 79, shadowRed: 107, shadowGreen: 79, shadowBlue: 55),
        .init(red: 224, green: 75, blue: 68, shadowRed: 194, shadowGreen: 53, shadowBlue: 48),
        .init(red: 240, green: 138, blue: 36, shadowRed: 219, shadowGreen: 110, shadowBlue: 13),
        .init(red: 242, green: 176, blue: 30, shadowRed: 222, shadowGreen: 148, shadowBlue: 16),
        .init(red: 63, green: 169, blue: 92, shadowRed: 46, shadowGreen: 138, shadowBlue: 71),
        .init(red: 47, green: 169, blue: 140, shadowRed: 34, shadowGreen: 134, shadowBlue: 110),
        .init(red: 61, green: 123, blue: 242, shadowRed: 42, shadowGreen: 95, shadowBlue: 208),
        .init(red: 139, green: 92, blue: 246, shadowRed: 111, shadowGreen: 63, shadowBlue: 224),
        .init(red: 224, green: 85, blue: 159, shadowRed: 201, shadowGreen: 59, shadowBlue: 132),
        .init(red: 154, green: 160, blue: 166, shadowRed: 126, shadowGreen: 132, shadowBlue: 139),
    ]

    static let bodyPaths: [CGPath] = [
        CGPath(ellipseIn: CGRect(x: 6, y: 6, width: 52, height: 52), transform: nil),
        makePath { path in
            path.move(to: CGPoint(x: 32, y: 5))
            path.addCurve(to: CGPoint(x: 6, y: 29), control1: CGPoint(x: 17, y: 5), control2: CGPoint(x: 6, y: 15))
            path.addCurve(to: CGPoint(x: 28, y: 51), control1: CGPoint(x: 6, y: 41), control2: CGPoint(x: 15, y: 51))
            path.addCurve(to: CGPoint(x: 54, y: 30), control1: CGPoint(x: 42, y: 51), control2: CGPoint(x: 54, y: 43))
            path.addCurve(to: CGPoint(x: 32, y: 5), control1: CGPoint(x: 54, y: 17), control2: CGPoint(x: 45, y: 5))
            path.closeSubpath()
        },
        CGPath(
            roundedRect: CGRect(x: 7, y: 7, width: 50, height: 50),
            cornerWidth: 13,
            cornerHeight: 13,
            transform: nil
        ),
        CGPath(
            roundedRect: CGRect(x: 1, y: 8, width: 62, height: 48),
            cornerWidth: 24,
            cornerHeight: 24,
            transform: nil
        ),
        makePath { path in
            path.move(to: CGPoint(x: 27, y: 9))
            appendSVGArc(to: path, from: CGPoint(x: 27, y: 9), to: CGPoint(x: 37, y: 9), radiusX: 6, radiusY: 6, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 56, y: 42))
            appendSVGArc(to: path, from: CGPoint(x: 56, y: 42), to: CGPoint(x: 51, y: 51), radiusX: 6, radiusY: 6, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 13, y: 51))
            appendSVGArc(to: path, from: CGPoint(x: 13, y: 51), to: CGPoint(x: 8, y: 42), radiusX: 6, radiusY: 6, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 27, y: 9))
            path.closeSubpath()
        },
        makePath { path in
            path.move(to: CGPoint(x: 28, y: 6))
            appendSVGArc(to: path, from: CGPoint(x: 28, y: 6), to: CGPoint(x: 36, y: 6), radiusX: 8, radiusY: 8, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 53, y: 16))
            appendSVGArc(to: path, from: CGPoint(x: 53, y: 16), to: CGPoint(x: 57, y: 23), radiusX: 8, radiusY: 8, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 57, y: 43))
            appendSVGArc(to: path, from: CGPoint(x: 57, y: 43), to: CGPoint(x: 53, y: 50), radiusX: 8, radiusY: 8, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 36, y: 60))
            appendSVGArc(to: path, from: CGPoint(x: 36, y: 60), to: CGPoint(x: 28, y: 60), radiusX: 8, radiusY: 8, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 11, y: 50))
            appendSVGArc(to: path, from: CGPoint(x: 11, y: 50), to: CGPoint(x: 7, y: 43), radiusX: 8, radiusY: 8, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 7, y: 23))
            appendSVGArc(to: path, from: CGPoint(x: 7, y: 23), to: CGPoint(x: 11, y: 16), radiusX: 8, radiusY: 8, largeArc: false, sweep: true)
            path.addLine(to: CGPoint(x: 28, y: 6))
            path.closeSubpath()
        },
        makePath { path in
            path.move(to: CGPoint(x: 20, y: 54))
            path.addCurve(to: CGPoint(x: 5, y: 41), control1: CGPoint(x: 11, y: 54), control2: CGPoint(x: 5, y: 48))
            path.addCurve(to: CGPoint(x: 15, y: 28), control1: CGPoint(x: 5, y: 35), control2: CGPoint(x: 9, y: 30))
            path.addCurve(to: CGPoint(x: 33, y: 10), control1: CGPoint(x: 16, y: 18), control2: CGPoint(x: 23, y: 10))
            path.addCurve(to: CGPoint(x: 51, y: 24), control1: CGPoint(x: 42, y: 10), control2: CGPoint(x: 49, y: 16))
            path.addLine(to: CGPoint(x: 54, y: 24))
            path.addCurve(to: CGPoint(x: 63, y: 36), control1: CGPoint(x: 59, y: 24), control2: CGPoint(x: 63, y: 29))
            path.addCurve(to: CGPoint(x: 46, y: 54), control1: CGPoint(x: 63, y: 46), control2: CGPoint(x: 56, y: 54))
            path.addLine(to: CGPoint(x: 20, y: 54))
            path.closeSubpath()
        },
        makePath { path in
            path.move(to: CGPoint(x: 32, y: 4))
            path.addCurve(to: CGPoint(x: 12, y: 39), control1: CGPoint(x: 22, y: 18), control2: CGPoint(x: 12, y: 28))
            appendSVGArc(to: path, from: CGPoint(x: 12, y: 39), to: CGPoint(x: 52, y: 39), radiusX: 20, radiusY: 20, largeArc: false, sweep: false)
            path.addCurve(to: CGPoint(x: 32, y: 4), control1: CGPoint(x: 52, y: 28), control2: CGPoint(x: 42, y: 18))
            path.closeSubpath()
        },
    ]

    static let leftEye = CGPath(ellipseIn: CGRect(x: 23.4, y: 25.6, width: 5.2, height: 8.8), transform: nil)
    static let rightEye = CGPath(ellipseIn: CGRect(x: 35.4, y: 25.6, width: 5.2, height: 8.8), transform: nil)
    static let ohMouth = CGPath(ellipseIn: CGRect(x: 29, y: 35, width: 6, height: 8), transform: nil)
    static let smileMouth = makePath { path in
        path.move(to: CGPoint(x: 27, y: 38))
        path.addQuadCurve(to: CGPoint(x: 37, y: 38), control: CGPoint(x: 32, y: 43))
    }
    static let catMouth = makePath { path in
        path.move(to: CGPoint(x: 27, y: 38))
        path.addQuadCurve(to: CGPoint(x: 32, y: 38), control: CGPoint(x: 29.5, y: 41))
        path.addQuadCurve(to: CGPoint(x: 37, y: 38), control: CGPoint(x: 34.5, y: 41))
    }
    static let grinMouth = makePath { path in
        path.move(to: CGPoint(x: 26, y: 37))
        path.addLine(to: CGPoint(x: 38, y: 37))
        path.addQuadCurve(to: CGPoint(x: 32, y: 43), control: CGPoint(x: 37, y: 43))
        path.addQuadCurve(to: CGPoint(x: 26, y: 37), control: CGPoint(x: 27, y: 43))
        path.closeSubpath()
    }

    static let antennaStem = makePath { path in
        path.move(to: CGPoint(x: 32, y: 8))
        path.addLine(to: CGPoint(x: 36, y: 2))
    }
    static let antennaTip = CGPath(ellipseIn: CGRect(x: 34, y: -1, width: 6, height: 6), transform: nil)
    static let halo = CGPath(ellipseIn: CGRect(x: 20, y: 0.5, width: 24, height: 7), transform: nil)
    static let crown = makePath { path in
        path.move(to: CGPoint(x: 20, y: 8))
        path.addLine(to: CGPoint(x: 24, y: 1))
        path.addLine(to: CGPoint(x: 32, y: 6))
        path.addLine(to: CGPoint(x: 40, y: 1))
        path.addLine(to: CGPoint(x: 44, y: 8))
        path.closeSubpath()
    }
    static let bow = makePath { path in
        path.move(to: CGPoint(x: 46, y: 12))
        path.addLine(to: CGPoint(x: 56, y: 7))
        path.addLine(to: CGPoint(x: 56, y: 17))
        path.closeSubpath()
    }
    static let bowKnot = CGPath(ellipseIn: CGRect(x: 42.4, y: 9.4, width: 5.2, height: 5.2), transform: nil)
    static let headphoneBand = makePath { path in
        path.move(to: CGPoint(x: 12, y: 30))
        appendSVGArc(to: path, from: CGPoint(x: 12, y: 30), to: CGPoint(x: 52, y: 30), radiusX: 20, radiusY: 20, largeArc: false, sweep: true)
    }
    static let leftHeadphone = CGPath(roundedRect: CGRect(x: 8, y: 28, width: 7, height: 12), cornerWidth: 3.5, cornerHeight: 3.5, transform: nil)
    static let rightHeadphone = CGPath(roundedRect: CGRect(x: 49, y: 28, width: 7, height: 12), cornerWidth: 3.5, cornerHeight: 3.5, transform: nil)
    static let accessoryStar = makePath { path in
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

    private static func makePath(_ body: (CGMutablePath) -> Void) -> CGPath {
        let path = CGMutablePath()
        body(path)
        return path
    }

    /// Converts the endpoint-arc commands used by the web catalog to cubic Core Graphics paths.
    private static func appendSVGArc(
        to path: CGMutablePath,
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
            let startPoint = ellipsePoint(angle: startAngle, center: center, radiusX: radiusX, radiusY: radiusY, cosine: cosine, sine: sine)
            let endPoint = ellipsePoint(angle: endAngle, center: center, radiusX: radiusX, radiusY: radiusY, cosine: cosine, sine: sine)
            let startDerivative = ellipseDerivative(angle: startAngle, radiusX: radiusX, radiusY: radiusY, cosine: cosine, sine: sine)
            let endDerivative = ellipseDerivative(angle: endAngle, radiusX: radiusX, radiusY: radiusY, cosine: cosine, sine: sine)
            let alpha = 4 / 3 * tan(segmentAngle / 4)
            path.addCurve(
                to: endPoint,
                control1: CGPoint(x: startPoint.x + alpha * startDerivative.x, y: startPoint.y + alpha * startDerivative.y),
                control2: CGPoint(x: endPoint.x - alpha * endDerivative.x, y: endPoint.y - alpha * endDerivative.y)
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

private extension CompanionNotificationAvatar {
    static func renderWithCoreGraphics(icon: CompanionNotificationIcon, size: Int) throws -> Data {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let context = CGContext(
            data: nil,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: size * 4,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else {
            throw RenderError.bitmapContextUnavailable
        }

        context.setAllowsAntialiasing(true)
        context.setShouldAntialias(true)
        context.setInterpolationQuality(.high)
        context.clear(CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)))

        // Canvas and SVG coordinates have their origin at the top-left. Bitmap contexts use the
        // opposite default, so flip once around the complete canvas before drawing the catalog.
        context.saveGState()
        context.translateBy(x: 0, y: CGFloat(size))
        context.scaleBy(x: 1, y: -1)
        drawAvatar(icon: icon, size: size, in: context)
        context.restoreGState()

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

    private static func drawAvatar(icon: CompanionNotificationIcon, size: Int, in context: CGContext) {
        let viewBox = CGSize(width: 64, height: 68)
        let canvasSize = CGFloat(size)
        let viewScale = min(canvasSize / viewBox.width, canvasSize / viewBox.height)
        let viewTransform = CGAffineTransform(
            a: viewScale,
            b: 0,
            c: 0,
            d: viewScale,
            tx: (canvasSize - viewBox.width * viewScale) / 2,
            ty: (canvasSize - viewBox.height * viewScale) / 2
        )
        let bodyTransform = CGAffineTransform(a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0)
        let catalog = CompanionNotificationAvatarCatalog.self

        drawAccessory(icon.accessory, bodyTransform: bodyTransform, viewTransform: viewTransform, scale: viewScale, in: context)
        let bodyPath = applying(catalog.bodyPaths[icon.shape], first: bodyTransform, then: viewTransform)
        drawBody(bodyPath, color: catalog.colors[icon.color], in: context)
        drawFace(icon.mouth, bodyTransform: bodyTransform, viewTransform: viewTransform, scale: viewScale, in: context)
    }

    private static func applying(
        _ path: CGPath,
        first: CGAffineTransform,
        then second: CGAffineTransform
    ) -> CGPath {
        var first = first
        guard let transformed = path.copy(using: &first) else { return path }
        var second = second
        return transformed.copy(using: &second) ?? transformed
    }

    private static func drawBody(_ path: CGPath, color: CompanionAvatarColor, in context: CGContext) {
        let bounds = path.boundingBoxOfPath
        guard bounds.width > 0, bounds.height > 0 else { return }
        let light = color.lightened(by: 55).cgColor
        let base = color.cgColor
        let shadow = color.shadow.cgColor
        guard let gradient = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [light, base, shadow] as CFArray,
            locations: [0, 0.55, 1]
        ) else { return }

        context.saveGState()
        context.addPath(path)
        context.clip()
        let center = CGPoint(x: bounds.minX + bounds.width * 0.35, y: bounds.minY + bounds.height * 0.28)
        context.drawRadialGradient(
            gradient,
            startCenter: center,
            startRadius: 0,
            endCenter: center,
            endRadius: max(bounds.width, bounds.height) * 0.85,
            options: []
        )
        context.restoreGState()
    }

    private static func drawFace(
        _ mouth: Int,
        bodyTransform: CGAffineTransform,
        viewTransform: CGAffineTransform,
        scale: CGFloat,
        in context: CGContext
    ) {
        let catalog = CompanionNotificationAvatarCatalog.self
        func transformed(_ path: CGPath) -> CGPath {
            applying(path, first: bodyTransform, then: viewTransform)
        }
        let ink = CompanionAvatarColor(red: 16, green: 16, blue: 20).cgColor
        fill(transformed(catalog.leftEye), color: ink, in: context)
        fill(transformed(catalog.rightEye), color: ink, in: context)

        switch mouth {
        case 0:
            break
        case 2:
            fill(transformed(catalog.ohMouth), color: ink, in: context)
        case 4:
            fill(transformed(catalog.grinMouth), color: ink, in: context)
        case 3:
            stroke(transformed(catalog.catMouth), color: ink, width: 2.2 * scale, cap: .round, in: context)
        default:
            stroke(transformed(catalog.smileMouth), color: ink, width: 2.4 * scale, cap: .round, in: context)
        }
    }

    private static func drawAccessory(
        _ accessory: Int,
        bodyTransform: CGAffineTransform,
        viewTransform: CGAffineTransform,
        scale: CGFloat,
        in context: CGContext
    ) {
        let catalog = CompanionNotificationAvatarCatalog.self
        func transformed(_ path: CGPath) -> CGPath {
            applying(path, first: bodyTransform, then: viewTransform)
        }
        let gold = CompanionAvatarColor(red: 242, green: 176, blue: 30).cgColor
        let pink = CompanionAvatarColor(red: 224, green: 85, blue: 159).cgColor
        let gray = CompanionAvatarColor(red: 154, green: 160, blue: 166).cgColor

        switch accessory {
        case 1:
            stroke(transformed(catalog.antennaStem), color: gold, width: 2.4 * scale, cap: .round, in: context)
            fill(transformed(catalog.antennaTip), color: gold, in: context)
        case 2:
            stroke(transformed(catalog.halo), color: gold, width: 2.6 * scale, in: context)
        case 3:
            fill(transformed(catalog.crown), color: gold, in: context)
        case 4:
            fill(transformed(catalog.bow), color: pink, in: context)
            fill(transformed(catalog.bowKnot), color: pink, in: context)
        case 5:
            stroke(transformed(catalog.headphoneBand), color: gray, width: 3.4 * scale, in: context)
            fill(transformed(catalog.leftHeadphone), color: gray, in: context)
            fill(transformed(catalog.rightHeadphone), color: gray, in: context)
        case 6:
            fill(transformed(catalog.accessoryStar), color: gold, in: context)
        default:
            break
        }
    }

    private static func fill(_ path: CGPath, color: CGColor, in context: CGContext) {
        context.saveGState()
        context.setFillColor(color)
        context.addPath(path)
        context.fillPath()
        context.restoreGState()
    }

    private static func stroke(
        _ path: CGPath,
        color: CGColor,
        width: CGFloat,
        cap: CGLineCap = .butt,
        in context: CGContext
    ) {
        context.saveGState()
        context.setStrokeColor(color)
        context.setLineWidth(width)
        context.setLineCap(cap)
        context.setLineJoin(.round)
        context.addPath(path)
        context.strokePath()
        context.restoreGState()
    }
}

private extension CompanionAvatarColor {
    var cgColor: CGColor {
        CGColor(
            red: CGFloat(red) / 255,
            green: CGFloat(green) / 255,
            blue: CGFloat(blue) / 255,
            alpha: 1
        )
    }
}
