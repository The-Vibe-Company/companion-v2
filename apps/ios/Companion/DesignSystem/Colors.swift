import SwiftUI
import UIKit

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
    static let companionDanger = Color(red: 0.76, green: 0.08, blue: 0.16)
    static let companionSuccess = Color(red: 0.08, green: 0.56, blue: 0.31)
    static let companionWarning = Color(red: 0.84, green: 0.45, blue: 0.03)
    static let companionAccentForeground = Color.white

    private static func adaptive(light: UIColor, dark: UIColor) -> Color {
        Color(
            uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark ? dark : light
            }
        )
    }
}
