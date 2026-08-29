import Foundation

/// Device-local appearance choices shared by the settings model and the app root.
public enum CompanionAppearancePreference: String, CaseIterable, Codable, Equatable, Hashable, Sendable {
    case system
    case black

    public var label: String {
        switch self {
        case .system: "System"
        case .black: "Black"
        }
    }

    /// Black is the only explicit override. System deliberately leaves the OS appearance in charge.
    public var forcesBlackPalette: Bool { self == .black }
}

/// Approved RGB values from `docs/ios-design.md`. Keeping these numeric values in one palette
/// lets the shared SwiftUI theme bridge to UIKit/AppKit without duplicating platform literals.
public enum CompanionAppearancePalette {
    public enum Light {
        public static let canvas: UInt32 = 0xFFFFFF
        public static let card: UInt32 = 0xF2F2F7
        public static let botBubble: UInt32 = 0xEFEFF1
        public static let innerBubble: UInt32 = 0xFFFFFF
        public static let chip: UInt32 = 0xEFEFF1
        public static let userBubble: UInt32 = 0x0B0B0F
        public static let userBubbleText: UInt32 = 0xFFFFFF
        public static let textPrimary: UInt32 = 0x111111
        public static let separator: UInt32 = 0xE5E5EA
        public static let primaryCTA: UInt32 = 0x0B0B0F
        public static let primaryCTAText: UInt32 = 0xFFFFFF
    }

    public enum Black {
        public static let canvas: UInt32 = 0x000000
        public static let card: UInt32 = 0x1C1C1E
        public static let botBubble: UInt32 = 0x1C1C1E
        public static let innerBubble: UInt32 = 0x1C1C1E
        public static let chip: UInt32 = 0x1C1C1E
        public static let userBubble: UInt32 = 0xFFFFFF
        public static let userBubbleText: UInt32 = 0x000000
        public static let textPrimary: UInt32 = 0xF2F2F7
        public static let separator: UInt32 = 0x38383A
        public static let primaryCTA: UInt32 = 0xFFFFFF
        public static let primaryCTAText: UInt32 = 0x000000
    }

    public static let textSecondary: UInt32 = 0x8E8E93
    public static let actionBlue: UInt32 = 0x007AFF
    public static let actionBlueBlack: UInt32 = 0x0A84FF
    public static let toggleGreen: UInt32 = 0x34C759
    public static let danger: UInt32 = 0xFF3B30
    public static let warning: UInt32 = 0xFF9500

    // Text variants preserve the semantic hue while meeting small-text contrast on light surfaces.
    public static let dangerTextLight: UInt32 = 0xC21429
    public static let successTextLight: UInt32 = 0x10733B
    public static let warningTextLight: UInt32 = 0x955000

    public static let characterMarks: [UInt32] = [
        0x000000, 0xA2845E, 0xFF3B30, 0xFF9500, 0xFFCC00, 0x34C759,
        0x30B0C7, 0x007AFF, 0xAF52DE, 0xFF2D55, 0x8E8E93,
    ]
}
