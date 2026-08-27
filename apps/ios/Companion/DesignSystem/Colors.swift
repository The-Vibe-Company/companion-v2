import SwiftUI
import UIKit

/// Approved Grok Bot palette for native iOS surfaces. Wave-specific views should use these
/// semantic tokens so System and Black appearance can swap surfaces without changing mark colors.
enum CompanionIOSTheme {
    static let canvas = adaptive(light: 0xFFFFFF, black: 0x000000)
    static let card = adaptive(light: 0xF2F2F7, black: 0x1C1C1E)
    static let botBubble = adaptive(light: 0xEFEFF1, black: 0x1C1C1E)
    static let innerBubble = adaptive(light: 0xFFFFFF, black: 0x1C1C1E)
    static let chip = adaptive(light: 0xEFEFF1, black: 0x1C1C1E)
    static let userBubble = adaptive(light: 0x0B0B0F, black: 0xFFFFFF)
    static let userBubbleText = adaptive(light: 0xFFFFFF, black: 0x000000)
    static let textPrimary = adaptive(light: 0x111111, black: 0xF2F2F7)
    static let textSecondary = Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255)
    static let separator = adaptive(light: 0xE5E5EA, black: 0x38383A)
    static let primaryCTA = adaptive(light: 0x0B0B0F, black: 0xFFFFFF)
    static let primaryCTAText = adaptive(light: 0xFFFFFF, black: 0x000000)
    static let actionBlue = Color(red: 0, green: 122 / 255, blue: 1)
    static let toggleGreen = Color(red: 52 / 255, green: 199 / 255, blue: 89 / 255)
    static let danger = Color(red: 1, green: 59 / 255, blue: 48 / 255)

    private static func adaptive(light: UInt32, black: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(rgb: traits.userInterfaceStyle == .dark ? black : light)
        })
    }
}

extension Color {
    static let companionCanvas = adaptive(
        light: UIColor(red: 0.955, green: 0.965, blue: 0.985, alpha: 1),
        dark: UIColor(red: 0.045, green: 0.052, blue: 0.075, alpha: 1)
    )
    static let companionInk = adaptive(
        light: UIColor(red: 0.055, green: 0.065, blue: 0.095, alpha: 1),
        dark: UIColor(red: 0.94, green: 0.945, blue: 0.965, alpha: 1)
    )
    static let companionMuted = adaptive(
        light: UIColor(red: 0.35, green: 0.37, blue: 0.43, alpha: 1),
        dark: UIColor(red: 0.68, green: 0.70, blue: 0.76, alpha: 1)
    )
    static let companionAccent = Color(red: 0.91, green: 0.16, blue: 0.25)
    static let companionAccentWarm = Color(red: 0.98, green: 0.47, blue: 0.11)
    static let companionAccentGold = Color(red: 1.00, green: 0.72, blue: 0.10)
    static let companionSurface = adaptive(
        light: UIColor(white: 1, alpha: 0.72),
        dark: UIColor(red: 0.10, green: 0.11, blue: 0.15, alpha: 0.86)
    )
    static let companionSurfaceRaised = adaptive(
        light: UIColor(white: 1, alpha: 0.56),
        dark: UIColor(red: 0.16, green: 0.17, blue: 0.22, alpha: 0.82)
    )
    static let companionSurfaceOpaque = adaptive(
        light: UIColor(white: 1, alpha: 1),
        dark: UIColor(red: 0.10, green: 0.11, blue: 0.15, alpha: 1)
    )
    static let companionBorder = adaptive(
        light: UIColor(white: 1, alpha: 0.78),
        dark: UIColor(white: 1, alpha: 0.16)
    )
    static let companionDivider = adaptive(
        light: UIColor(white: 0, alpha: 0.08),
        dark: UIColor(white: 1, alpha: 0.12)
    )
    static let companionDanger = adaptive(
        light: UIColor(red: 0.76, green: 0.08, blue: 0.16, alpha: 1),
        dark: UIColor(red: 1.00, green: 0.43, blue: 0.48, alpha: 1)
    )
    static let companionSuccess = adaptive(
        light: UIColor(red: 0.08, green: 0.56, blue: 0.31, alpha: 1),
        dark: UIColor(red: 0.28, green: 0.80, blue: 0.49, alpha: 1)
    )
    static let companionWarning = adaptive(
        light: UIColor(red: 0.84, green: 0.45, blue: 0.03, alpha: 1),
        dark: UIColor(red: 1.00, green: 0.68, blue: 0.24, alpha: 1)
    )
    static let companionAccentForeground = Color.white

    private static func adaptive(light: UIColor, dark: UIColor) -> Color {
        Color(
            uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark ? dark : light
            }
        )
    }
}

private extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
