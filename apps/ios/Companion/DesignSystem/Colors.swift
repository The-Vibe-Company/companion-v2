import SwiftUI
import CompanionKit

/// Compatibility forwarding for app-local Color spellings. The implementation and exact
/// platform bridge live in CompanionKit's CompanionIOSTheme; in particular
/// CompanionAppearancePalette.Black.canvas is not copied here.
/// The package also owns static let linkBlue = adaptive(...) and static let userBubbleLink = adaptive(...).
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
