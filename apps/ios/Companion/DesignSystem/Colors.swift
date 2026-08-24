import SwiftUI
import UIKit

extension Color {
    static let companionCanvas = Color(
        light: UIColor(red: 0.961, green: 0.969, blue: 0.980, alpha: 1),
        dark: UIColor(red: 0.055, green: 0.063, blue: 0.086, alpha: 1)
    )
    static let companionMuted = Color(
        light: UIColor(red: 0.42, green: 0.44, blue: 0.49, alpha: 1),
        dark: UIColor(red: 0.66, green: 0.68, blue: 0.74, alpha: 1)
    )
    static let companionAccent = Color(red: 0.929, green: 0.725, blue: 0)
    static let companionAccentForeground = Color(
        light: UIColor(red: 0.24, green: 0.21, blue: 0.10, alpha: 1),
        dark: UIColor(red: 0.24, green: 0.21, blue: 0.10, alpha: 1)
    )

    private init(light: UIColor, dark: UIColor) {
        self.init(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }
}
