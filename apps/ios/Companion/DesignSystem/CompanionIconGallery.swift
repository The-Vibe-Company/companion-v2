import SwiftUI
import CompanionKit

/// Wave A character picker: shape and palette only. Mouth/accessory indexes stay in transport
/// models for compatibility but are intentionally never exposed or rendered.
struct CharacterPicker: View {
    @Binding var selection: CompanionSummary.Icon
    var defaultSelection: CompanionSummary.Icon? = nil
    var accessibilityIdentifierPrefix = "companion.character"
    var reduceMotionOverride: Bool? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            optionRow(title: "Shape", count: CharacterMarkShape.allCases.count) { index in
                shapeOption(index)
            }
            optionRow(title: "Color", count: CharacterMark.palette.count) { index in
                colorOption(index)
            }

            if let defaultSelection, selection != defaultSelection {
                Button("Reset to default") {
                    update(defaultSelection)
                }
                .font(.system(size: 15, weight: .semibold))
                .accessibilityIdentifier("\(accessibilityIdentifierPrefix).reset")
            }
        }
    }

    private func optionRow<Content: View>(
        title: String,
        count: Int,
        @ViewBuilder content: @escaping (Int) -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 13))
                .foregroundStyle(Color.secondary)
            ScrollView(.horizontal) {
                LazyHStack(spacing: 12) {
                    ForEach(0..<count, id: \.self, content: content)
                }
                .padding(.horizontal, 2)
                .padding(.vertical, 3)
            }
            .scrollIndicators(.hidden)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(title) options")
        }
    }

    private func shapeOption(_ index: Int) -> some View {
        let selected = selection.shape == index
        return Button {
            update(.init(
                shape: index,
                mouth: selection.mouth,
                accessory: selection.accessory,
                color: selection.color
            ))
        } label: {
            CharacterMark(name: "Shape \(index + 1)", shapeIndex: index, colorIndex: selection.color, size: 48)
                .padding(5)
                .overlay(selectionRing(selected, diameter: 58))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Shape \(index + 1)")
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("\(accessibilityIdentifierPrefix).shape.\(index)")
    }

    private func colorOption(_ index: Int) -> some View {
        let selected = selection.color == index
        return Button {
            update(.init(
                shape: selection.shape,
                mouth: selection.mouth,
                accessory: selection.accessory,
                color: index
            ))
        } label: {
            Circle()
                .fill(CharacterMark.palette[index])
                .frame(width: 34, height: 34)
                .padding(6)
                .overlay(selectionRing(selected, diameter: 46))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(colorName(index))
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("\(accessibilityIdentifierPrefix).color.\(index)")
    }

    private func selectionRing(_ selected: Bool, diameter: CGFloat) -> some View {
        Circle()
            .stroke(selected ? Color.primary : Color.clear, lineWidth: 2)
            .frame(width: diameter, height: diameter)
            .accessibilityHidden(true)
    }

    private func update(_ icon: CompanionSummary.Icon) {
        if reduceMotionOverride ?? reduceMotion {
            selection = icon
        } else {
            withAnimation(.easeOut(duration: 0.2)) { selection = icon }
        }
    }

    private func colorName(_ index: Int) -> String {
        ["Black", "Brown", "Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple", "Pink", "Gray"][index]
    }
}

/// Temporary source-compatible name while downstream waves migrate their call sites.
typealias CompanionIconGallery = CharacterPicker
