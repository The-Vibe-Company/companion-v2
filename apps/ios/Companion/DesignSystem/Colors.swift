import SwiftUI
import CompanionKit

/// Compatibility forwarding for the few legacy app files that predate their explicit
/// CompanionKit import. The implementation and exact platform bridge live in the package's
/// CompanionIOSTheme; in particular CompanionAppearancePalette.Black.canvas is not copied here.
/// The package also owns static let linkBlue = adaptive(...) and static let userBubbleLink = adaptive(...).
typealias CompanionIOSTheme = CompanionKit.CompanionIOSTheme

/// Keep the old app-local Color spellings source-compatible while every value comes from the
/// package's shared theme. New native clients may use CompanionIOSTheme directly.
extension Color {
    static let companionCanvas = CompanionKit.CompanionIOSTheme.canvas
    static let companionInk = CompanionKit.CompanionIOSTheme.textPrimary
    static let companionMuted = CompanionKit.CompanionIOSTheme.textSecondary
    static let companionAccent = CompanionKit.CompanionIOSTheme.actionBlue
    static let companionAccentWarm = CompanionKit.CompanionIOSTheme.warning
    static let companionAccentGold = CompanionKit.CompanionIOSTheme.warning
    static let companionSurface = CompanionKit.CompanionIOSTheme.card
    static let companionSurfaceRaised = CompanionKit.CompanionIOSTheme.card
    static let companionSurfaceOpaque = CompanionKit.CompanionIOSTheme.card
    static let companionBorder = CompanionKit.CompanionIOSTheme.separator
    static let companionDivider = CompanionKit.CompanionIOSTheme.separator
    static let companionDanger = CompanionKit.CompanionIOSTheme.dangerText
    static let companionSuccess = CompanionKit.CompanionIOSTheme.successText
    static let companionWarning = CompanionKit.CompanionIOSTheme.warningText
    static let companionAccentForeground = Color.white
}
