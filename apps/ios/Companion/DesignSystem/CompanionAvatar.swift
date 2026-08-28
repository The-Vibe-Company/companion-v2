import CompanionKit
import SwiftUI

enum CompanionAvatarState: Equatable {
    case idle
    case thinking
    case still
}

/// Compatibility wrapper for call sites that still express an activity state. Character identity
/// is always the approved static shape, palette color, and two white eyes; mouth and accessory
/// indexes remain transport-only and activity never changes the mark artwork.
struct CompanionAvatar: View {
    let name: String
    var icon: CompanionSummary.Icon?
    var size: CGFloat = 48
    var state: CompanionAvatarState = .idle
    var reduceMotionOverride: Bool? = nil

    var body: some View {
        CharacterMark(name: name, icon: icon, size: size)
    }
}
