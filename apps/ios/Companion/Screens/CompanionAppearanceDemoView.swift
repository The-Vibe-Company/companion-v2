#if DEBUG
import CompanionKit
import SwiftUI

/// Snapshot-friendly showcase for the app-wide System / Black appearance contract.
struct CompanionAppearanceDemoView: View {
    @AppStorage(CompanionPreferenceKeys.appearance) private var appearanceValue = CompanionAppearancePreference.system.rawValue

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Appearance")
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)

                    Picker("Appearance", selection: appearanceBinding) {
                        ForEach(CompanionAppearancePreference.allCases, id: \.self) { preference in
                            Text(preference.label).tag(preference)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("demo.appearance.picker")

                    CompanionSheetCard {
                        HStack(spacing: 12) {
                            CharacterMark(name: "Luna", shapeIndex: 1, colorIndex: 7, size: 64)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Luna")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                                Text("Ready for the next task")
                                    .font(.system(size: 15))
                                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                            }
                            Spacer()
                        }
                        .padding(16)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("I’ll prepare the final polish pass.")
                            .font(.system(size: 16))
                            .foregroundStyle(CompanionIOSTheme.textPrimary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(CompanionIOSTheme.botBubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                        Text("Use the approved palette everywhere.")
                            .font(.system(size: 16))
                            .foregroundStyle(CompanionIOSTheme.userBubbleText)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(CompanionIOSTheme.userBubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }

                    Button("Continue") {}
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(CompanionIOSTheme.primaryCTA, in: Capsule())
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 24)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("demo.appearance.gallery")
    }

    private var appearanceBinding: Binding<CompanionAppearancePreference> {
        Binding(
            get: { CompanionAppearancePreference(rawValue: appearanceValue) ?? .system },
            set: { appearanceValue = $0.rawValue }
        )
    }
}
#endif
