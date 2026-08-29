import SwiftUI
import UIKit
import CompanionKit

/// Approved Grok Bot palette for native iOS surfaces. Wave-specific views should use these
/// semantic tokens so System and Black appearance can swap surfaces without changing mark colors.
enum CompanionIOSTheme {
    static let canvas = adaptive(light: CompanionAppearancePalette.Light.canvas, black: CompanionAppearancePalette.Black.canvas)
    static let card = adaptive(light: CompanionAppearancePalette.Light.card, black: CompanionAppearancePalette.Black.card)
    static let botBubble = adaptive(light: CompanionAppearancePalette.Light.botBubble, black: CompanionAppearancePalette.Black.botBubble)
    static let innerBubble = adaptive(light: CompanionAppearancePalette.Light.innerBubble, black: CompanionAppearancePalette.Black.innerBubble)
    static let chip = adaptive(light: CompanionAppearancePalette.Light.chip, black: CompanionAppearancePalette.Black.chip)
    static let userBubble = adaptive(light: CompanionAppearancePalette.Light.userBubble, black: CompanionAppearancePalette.Black.userBubble)
    static let userBubbleText = adaptive(light: CompanionAppearancePalette.Light.userBubbleText, black: CompanionAppearancePalette.Black.userBubbleText)
    static let textPrimary = adaptive(light: CompanionAppearancePalette.Light.textPrimary, black: CompanionAppearancePalette.Black.textPrimary)
    static let textSecondary = color(CompanionAppearancePalette.textSecondary)
    static let separator = adaptive(light: CompanionAppearancePalette.Light.separator, black: CompanionAppearancePalette.Black.separator)
    static let primaryCTA = adaptive(light: CompanionAppearancePalette.Light.primaryCTA, black: CompanionAppearancePalette.Black.primaryCTA)
    static let primaryCTAText = adaptive(light: CompanionAppearancePalette.Light.primaryCTAText, black: CompanionAppearancePalette.Black.primaryCTAText)
    static let actionBlue = color(CompanionAppearancePalette.actionBlue)
    static let linkBlue = adaptive(
        light: CompanionAppearancePalette.actionBlue,
        black: CompanionAppearancePalette.actionBlueBlack
    )
    static let userBubbleLink = adaptive(
        light: CompanionAppearancePalette.actionBlueBlack,
        black: CompanionAppearancePalette.actionBlue
    )
    static let toggleGreen = color(CompanionAppearancePalette.toggleGreen)
    static let danger = color(CompanionAppearancePalette.danger)
    static let warning = color(CompanionAppearancePalette.warning)
    static let dangerText = adaptive(
        light: CompanionAppearancePalette.dangerTextLight,
        black: CompanionAppearancePalette.danger
    )
    static let successText = adaptive(
        light: CompanionAppearancePalette.successTextLight,
        black: CompanionAppearancePalette.toggleGreen
    )
    static let warningText = adaptive(
        light: CompanionAppearancePalette.warningTextLight,
        black: CompanionAppearancePalette.warning
    )

    static let characterMarkPalette = CompanionAppearancePalette.characterMarks.map { color($0) }

    private static func adaptive(light: UInt32, black: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(rgb: traits.userInterfaceStyle == .dark ? black : light)
        })
    }

    private static func color(_ rgb: UInt32) -> Color {
        Color(uiColor: UIColor(rgb: rgb))
    }
}

extension Color {
    static let companionCanvas = CompanionIOSTheme.canvas
    static let companionInk = CompanionIOSTheme.textPrimary
    static let companionMuted = CompanionIOSTheme.textSecondary
    static let companionAccent = CompanionIOSTheme.actionBlue
    static let companionAccentWarm = CompanionIOSTheme.warning
    static let companionAccentGold = CompanionIOSTheme.warning
    static let companionSurface = CompanionIOSTheme.card
    static let companionSurfaceRaised = CompanionIOSTheme.card
    static let companionSurfaceOpaque = CompanionIOSTheme.card
    static let companionBorder = CompanionIOSTheme.separator
    static let companionDivider = CompanionIOSTheme.separator
    static let companionDanger = CompanionIOSTheme.dangerText
    static let companionSuccess = CompanionIOSTheme.successText
    static let companionWarning = CompanionIOSTheme.warningText
    static let companionAccentForeground = Color.white
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
