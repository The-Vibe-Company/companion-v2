import CoreGraphics
import Foundation
import ImageIO
import XCTest

@testable import CompanionNotificationAvatar

final class CompanionNotificationAvatarTests: XCTestCase {
    func testProjectsCharacterMarkFromReplyPayloadAndIgnoresLegacyFaceFields() {
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
            CompanionNotificationMark(apnsUserInfo: userInfo),
            CompanionNotificationMark(shape: 7, color: 10)
        )
    }

    func testProjectionRequiresOnlyTheRenderedShapeAndColor() {
        let userInfo: [AnyHashable: Any] = [
            "companion_icon": ["shape": 3, "color": 6],
        ]

        XCTAssertEqual(
            CompanionNotificationMark(apnsUserInfo: userInfo),
            CompanionNotificationMark(shape: 3, color: 6)
        )
    }

    func testRejectsMissingOutOfBoundsNonIntegerAndBooleanFields() {
        XCTAssertNil(CompanionNotificationMark(apnsUserInfo: [
            "companion_icon": ["shape": 1],
        ]))
        XCTAssertNil(CompanionNotificationMark(apnsUserInfo: [
            "companion_icon": ["shape": 8, "color": 0],
        ]))
        XCTAssertNil(CompanionNotificationMark(apnsUserInfo: [
            "companion_icon": ["shape": 1.5, "color": 2],
        ]))
        XCTAssertNil(CompanionNotificationMark(apnsUserInfo: [
            "companion_icon": ["shape": true, "color": 2],
        ]))
        XCTAssertNil(CompanionNotificationMark(apnsUserInfo: ["shape": 1, "color": 2]))
    }

    func testRendersDeterministicCharacterMarkPngWithExpectedDimensions() throws {
        let mark = CompanionNotificationMark(shape: 5, color: 7)
        let first = try CompanionNotificationAvatar.pngData(for: mark, size: 64)
        let second = try CompanionNotificationAvatar.pngData(for: mark, size: 64)

        XCTAssertEqual(first, second)
        XCTAssertEqual(Array(first.prefix(8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        XCTAssertGreaterThan(first.count, 24)
        XCTAssertEqual(Array(first[12..<16]), [0x49, 0x48, 0x44, 0x52])
        XCTAssertEqual(readUInt32(first, offset: 16), 64)
        XCTAssertEqual(readUInt32(first, offset: 20), 64)

        let source = CGImageSourceCreateWithData(first as CFData, nil)
        let image = source.flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
        XCTAssertEqual(image?.width, 64)
        XCTAssertEqual(image?.height, 64)
    }

    func testLegacyFaceIndexesCannotChangeRenderedCharacterMark() throws {
        let firstPayload: [AnyHashable: Any] = [
            "companion_icon": ["shape": 6, "mouth": 0, "accessory": 0, "color": 9],
        ]
        let secondPayload: [AnyHashable: Any] = [
            "companion_icon": ["shape": 6, "mouth": 4, "accessory": 6, "color": 9],
        ]
        let first = try XCTUnwrap(CompanionNotificationMark(apnsUserInfo: firstPayload))
        let second = try XCTUnwrap(CompanionNotificationMark(apnsUserInfo: secondPayload))

        XCTAssertEqual(first, second)
        XCTAssertEqual(
            try CompanionNotificationAvatar.pngData(for: first, size: 96),
            try CompanionNotificationAvatar.pngData(for: second, size: 96)
        )
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
