#if canImport(SwiftUI)
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The Grok Bot-derived native palette shared by the iOS and macOS clients.
///
/// Surface tokens dynamically follow the platform appearance: iOS uses a dynamic UIColor and
/// macOS uses a dynamic NSColor. Both bridges select the exact RGB values in
/// `CompanionAppearancePalette`; no platform-specific copy of the palette is maintained.
public enum CompanionIOSTheme {
    public static let canvas = adaptive(
        light: CompanionAppearancePalette.Light.canvas,
        black: CompanionAppearancePalette.Black.canvas
    )
    public static let card = adaptive(
        light: CompanionAppearancePalette.Light.card,
        black: CompanionAppearancePalette.Black.card
    )
    public static let botBubble = adaptive(
        light: CompanionAppearancePalette.Light.botBubble,
        black: CompanionAppearancePalette.Black.botBubble
    )
    public static let innerBubble = adaptive(
        light: CompanionAppearancePalette.Light.innerBubble,
        black: CompanionAppearancePalette.Black.innerBubble
    )
    public static let chip = adaptive(
        light: CompanionAppearancePalette.Light.chip,
        black: CompanionAppearancePalette.Black.chip
    )
    public static let userBubble = adaptive(
        light: CompanionAppearancePalette.Light.userBubble,
        black: CompanionAppearancePalette.Black.userBubble
    )
    public static let userBubbleText = adaptive(
        light: CompanionAppearancePalette.Light.userBubbleText,
        black: CompanionAppearancePalette.Black.userBubbleText
    )
    public static let textPrimary = adaptive(
        light: CompanionAppearancePalette.Light.textPrimary,
        black: CompanionAppearancePalette.Black.textPrimary
    )
    public static let textSecondary = color(CompanionAppearancePalette.textSecondary)
    public static let separator = adaptive(
        light: CompanionAppearancePalette.Light.separator,
        black: CompanionAppearancePalette.Black.separator
    )
    public static let primaryCTA = adaptive(
        light: CompanionAppearancePalette.Light.primaryCTA,
        black: CompanionAppearancePalette.Black.primaryCTA
    )
    public static let primaryCTAText = adaptive(
        light: CompanionAppearancePalette.Light.primaryCTAText,
        black: CompanionAppearancePalette.Black.primaryCTAText
    )
    public static let actionBlue = color(CompanionAppearancePalette.actionBlue)
    public static let linkBlue = adaptive(
        light: CompanionAppearancePalette.actionBlue,
        black: CompanionAppearancePalette.actionBlueBlack
    )
    public static let userBubbleLink = adaptive(
        light: CompanionAppearancePalette.actionBlueBlack,
        black: CompanionAppearancePalette.actionBlue
    )
    public static let toggleGreen = color(CompanionAppearancePalette.toggleGreen)
    public static let danger = color(CompanionAppearancePalette.danger)
    public static let warning = color(CompanionAppearancePalette.warning)

    // Text variants preserve the semantic hue while meeting small-text contrast on light
    // surfaces. The Black palette can use the brighter system signal colors directly.
    public static let dangerText = adaptive(
        light: CompanionAppearancePalette.dangerTextLight,
        black: CompanionAppearancePalette.danger
    )
    public static let successText = adaptive(
        light: CompanionAppearancePalette.successTextLight,
        black: CompanionAppearancePalette.toggleGreen
    )
    public static let warningText = adaptive(
        light: CompanionAppearancePalette.warningTextLight,
        black: CompanionAppearancePalette.warning
    )

    /// The eleven approved mark colors. Marks intentionally remain vivid across appearances.
    public static let characterMarkPalette = CompanionAppearancePalette.characterMarks.map { color($0) }

    private static func adaptive(light: UInt32, black: UInt32) -> Color {
#if canImport(UIKit)
        Color(uiColor: UIColor { traits in
            UIColor(companionRGB: traits.userInterfaceStyle == .dark ? black : light)
        })
#elseif canImport(AppKit)
        Color(nsColor: NSColor(name: nil) { appearance in
            let name = appearance.bestMatch(from: [.darkAqua, .aqua])
            return NSColor(companionRGB: name == .darkAqua ? black : light)
        })
#else
        // SwiftUI is available on the supported Apple platforms. Keep a deterministic fallback
        // for SwiftUI-compatible test hosts that do not vend UIKit or AppKit.
        color(light)
#endif
    }

    private static func color(_ rgb: UInt32) -> Color {
#if canImport(UIKit)
        Color(uiColor: UIColor(companionRGB: rgb))
#elseif canImport(AppKit)
        Color(nsColor: NSColor(companionRGB: rgb))
#else
        Color(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
#endif
    }
}

/// A neutral spelling for clients that do not need to preserve the historical iOS name.
public typealias CompanionTheme = CompanionIOSTheme

/// Shared SwiftUI palette aliases retained for existing iOS call sites and available to macOS.
public extension Color {
    public static let companionCanvas = CompanionIOSTheme.canvas
    public static let companionInk = CompanionIOSTheme.textPrimary
    public static let companionMuted = CompanionIOSTheme.textSecondary
    public static let companionAccent = CompanionIOSTheme.actionBlue
    public static let companionAccentWarm = CompanionIOSTheme.warning
    public static let companionAccentGold = CompanionIOSTheme.warning
    public static let companionSurface = CompanionIOSTheme.card
    public static let companionSurfaceRaised = CompanionIOSTheme.card
    public static let companionSurfaceOpaque = CompanionIOSTheme.card
    public static let companionBorder = CompanionIOSTheme.separator
    public static let companionDivider = CompanionIOSTheme.separator
    public static let companionDanger = CompanionIOSTheme.dangerText
    public static let companionSuccess = CompanionIOSTheme.successText
    public static let companionWarning = CompanionIOSTheme.warningText
    public static let companionAccentForeground = Color.white
}

#if canImport(UIKit)
private extension UIColor {
    convenience init(companionRGB rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
#elseif canImport(AppKit)
private extension NSColor {
    convenience init(companionRGB rgb: UInt32) {
        self.init(
            calibratedRed: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
#endif
#endif
