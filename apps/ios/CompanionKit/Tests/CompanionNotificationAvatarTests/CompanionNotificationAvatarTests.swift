import CoreGraphics
import Foundation
import ImageIO
import XCTest

@testable import CompanionNotificationAvatar

final class CompanionNotificationAvatarTests: XCTestCase {
    func testParsesNestedCompanionIconFields() {
        let userInfo: [AnyHashable: Any] = [
            "version": 1,
            "companion_icon": [
                "shape": NSNumber(value: 7),
                "mouth": NSNumber(value: 4),
                "accessory": NSNumber(value: 6),
                "color": NSNumber(value: 10),
            ],
        ]

        XCTAssertEqual(
            CompanionNotificationIcon(apnsUserInfo: userInfo),
            CompanionNotificationIcon(shape: 7, mouth: 4, accessory: 6, color: 10)
        )
    }

    func testRejectsMissingAndOutOfBoundsCompanionIconFields() {
        let missing: [AnyHashable: Any] = [
            "companion_icon": [
                "shape": 1,
                "mouth": 1,
                "accessory": 1,
            ],
        ]
        XCTAssertNil(CompanionNotificationIcon(apnsUserInfo: missing))

        let outOfBounds: [AnyHashable: Any] = [
            "companion_icon": [
                "shape": 8,
                "mouth": 0,
                "accessory": 0,
                "color": 0,
            ],
        ]
        XCTAssertNil(CompanionNotificationIcon(apnsUserInfo: outOfBounds))
    }

    func testRejectsNonIntegerAndBooleanFields() {
        let fractional: [AnyHashable: Any] = [
            "companion_icon": [
                "shape": 1.5,
                "mouth": 1,
                "accessory": 1,
                "color": 2,
            ],
        ]
        XCTAssertNil(CompanionNotificationIcon(apnsUserInfo: fractional))

        let boolean: [AnyHashable: Any] = [
            "companion_icon": [
                "shape": true,
                "mouth": 1,
                "accessory": 1,
                "color": 2,
            ],
        ]
        XCTAssertNil(CompanionNotificationIcon(apnsUserInfo: boolean))
    }

    func testRejectsTopLevelFieldsWithoutCompanionIconWrapper() {
        let userInfo: [AnyHashable: Any] = [
            "shape": 1,
            "mouth": 1,
            "accessory": 1,
            "color": 2,
        ]

        XCTAssertNil(CompanionNotificationIcon(apnsUserInfo: userInfo))
    }

    func testRendersDeterministicDefaultPngWithExpectedDimensions() throws {
        let first = try CompanionNotificationAvatar.pngData(
            for: .defaultIcon,
            size: 64
        )
        let second = try CompanionNotificationAvatar.pngData(
            for: .defaultIcon,
            size: 64
        )

        XCTAssertEqual(first, second)
        XCTAssertEqual(
            Array(first.prefix(8)),
            [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        )
        XCTAssertGreaterThan(first.count, 24)

        // PNG's first chunk is IHDR: length (4), type (4), width (4), height (4).
        XCTAssertEqual(Array(first[12..<16]), [0x49, 0x48, 0x44, 0x52])
        XCTAssertEqual(readUInt32(first, offset: 16), 64)
        XCTAssertEqual(readUInt32(first, offset: 20), 64)

        let source = CGImageSourceCreateWithData(first as CFData, nil)
        let image = source.flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
        XCTAssertEqual(image?.width, 64)
        XCTAssertEqual(image?.height, 64)
    }

    func testRejectsInvalidPngSizes() {
        XCTAssertThrowsError(try CompanionNotificationAvatar.pngData(size: 0)) { error in
            XCTAssertEqual(error as? CompanionNotificationAvatar.RenderError, .invalidSize)
        }
        XCTAssertThrowsError(
            try CompanionNotificationAvatar.pngData(size: CompanionNotificationAvatar.maximumSize + 1)
        ) { error in
            XCTAssertEqual(error as? CompanionNotificationAvatar.RenderError, .invalidSize)
        }
    }

    private func readUInt32(_ data: Data, offset: Int) -> UInt32 {
        UInt32(data[offset]) << 24
            | UInt32(data[offset + 1]) << 16
            | UInt32(data[offset + 2]) << 8
            | UInt32(data[offset + 3])
    }
}
