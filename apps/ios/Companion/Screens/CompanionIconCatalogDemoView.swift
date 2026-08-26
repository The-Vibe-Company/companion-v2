#if DEBUG
import SwiftUI
import CompanionKit

struct CompanionIconCatalogDemoView: View {
    private let baseIcon = CompanionSummary.Icon(shape: 1, mouth: 1, accessory: 1, color: 2)
    var forceReduceMotion = false

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @State private var selectedIcon = CompanionSummary.Icon(shape: 1, mouth: 1, accessory: 1, color: 2)

    private var reduceMotion: Bool {
        forceReduceMotion || systemReduceMotion
    }

    private var reduceMotionOverride: Bool? {
        forceReduceMotion ? true : nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    Label {
                        Text(reduceMotion ? "Reduce Motion: On" : "Reduce Motion: Off")
                    } icon: {
                        Image(systemName: reduceMotion ? "tortoise.fill" : "hare.fill")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(reduceMotion ? Color.companionSuccess : Color.companionMuted)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Reduce Motion")
                    .accessibilityValue(reduceMotion ? "On" : "Off")
                    .accessibilityIdentifier("demo.icon.reduce-motion")

                    CompanionIconGallery(
                        selection: $selectedIcon,
                        accessibilityIdentifierPrefix: "demo.icon",
                        reduceMotionOverride: reduceMotionOverride
                    )

                    VStack(alignment: .leading, spacing: 12) {
                        Text("States")
                            .font(.headline)
                        HStack(alignment: .top, spacing: 22) {
                            stateSample("Idle", state: .idle, identifier: "idle")
                            stateSample("Thinking", state: .thinking, identifier: "thinking")
                            stateSample("Still", state: .still, identifier: "still")
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Sizes")
                            .font(.headline)
                        HStack(alignment: .bottom, spacing: 24) {
                            sizeSample(30)
                            sizeSample(52)
                            sizeSample(86)
                        }
                    }
                }
                .padding(20)
            }
            .background(Color.companionCanvas)
            .navigationTitle("Companion icon catalog")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func stateSample(
        _ label: String,
        state: CompanionAvatarState,
        identifier: String
    ) -> some View {
        VStack(spacing: 7) {
            CompanionAvatar(
                name: label,
                icon: baseIcon,
                size: 64,
                state: state,
                reduceMotionOverride: reduceMotionOverride
            )
            Text(label)
                .font(.caption)
                .foregroundStyle(Color.companionMuted)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("demo.icon.state.\(identifier)")
    }

    private func sizeSample(_ size: Int) -> some View {
        VStack(spacing: 7) {
            CompanionAvatar(
                name: "Size \(size)",
                icon: baseIcon,
                size: CGFloat(size),
                state: .still,
                reduceMotionOverride: reduceMotionOverride
            )
            Text("\(size) pt")
                .font(.caption.monospacedDigit())
                .foregroundStyle(Color.companionMuted)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("demo.icon.size.\(size)")
    }
}

#Preview("Companion icon catalog") {
    CompanionIconCatalogDemoView()
}
#endif
