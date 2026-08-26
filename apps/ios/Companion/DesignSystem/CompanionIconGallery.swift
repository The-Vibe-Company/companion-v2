import SwiftUI
import CompanionKit

/// The complete, closed Companion icon catalog rendered as four visual radio groups.
struct CompanionIconGallery: View {
    @Binding var selection: CompanionSummary.Icon
    var accessibilityIdentifierPrefix = "companion.icon"

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = [
        GridItem(.adaptive(minimum: 68, maximum: 88), spacing: 10, alignment: .top),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            ForEach(IconPart.allCases) { part in
                iconSection(part)
            }
        }
    }

    private func iconSection(_ part: IconPart) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(part.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.companionInk)

            LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
                ForEach(0..<part.count, id: \.self) { index in
                    option(part: part, index: index)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(part.title) icon options")
            .accessibilityIdentifier("\(accessibilityIdentifierPrefix).\(part.identifier).grid")
        }
    }

    private func option(part: IconPart, index: Int) -> some View {
        let selected = part.value(in: selection) == index
        let label = "\(part.optionName) \(index + 1)"

        return Button {
            let updated = part.replacingValue(in: selection, with: index)
            if reduceMotion {
                selection = updated
            } else {
                withAnimation(.easeOut(duration: 0.18)) {
                    selection = updated
                }
            }
        } label: {
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 4) {
                    CompanionAvatar(
                        name: label,
                        icon: part.previewIcon(index: index, selection: selection),
                        size: 52,
                        state: .still
                    )
                    .accessibilityHidden(true)

                    Text("\(index + 1)")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(selected ? Color.companionAccent : Color.companionMuted)
                }
                .frame(maxWidth: .infinity, minHeight: 78)
                .padding(.horizontal, 6)
                .padding(.vertical, 7)

                if selected {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.companionAccentForeground)
                        .frame(width: 22, height: 22)
                        .background(Color.companionAccent, in: Circle())
                        .padding(5)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .companionMaterial(radius: 16)
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(
                    selected ? Color.companionAccent : Color.clear,
                    lineWidth: selected ? 3 : 0
                )
                .padding(1.5)
                .allowsHitTesting(false)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), Companion icon")
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("\(accessibilityIdentifierPrefix).\(part.identifier).\(index)")
    }
}

private enum IconPart: String, CaseIterable, Identifiable {
    case shape
    case mouth
    case accessory
    case color

    var id: String { rawValue }
    var identifier: String { rawValue }

    var title: String {
        switch self {
        case .shape: "Shape"
        case .mouth: "Face"
        case .accessory: "Style"
        case .color: "Color"
        }
    }

    var optionName: String { title }

    var count: Int {
        switch self {
        case .shape: 8
        case .mouth: 5
        case .accessory: 7
        case .color: 11
        }
    }

    func value(in icon: CompanionSummary.Icon) -> Int {
        switch self {
        case .shape: icon.shape
        case .mouth: icon.mouth
        case .accessory: icon.accessory
        case .color: icon.color
        }
    }

    func replacingValue(
        in icon: CompanionSummary.Icon,
        with value: Int
    ) -> CompanionSummary.Icon {
        switch self {
        case .shape:
            .init(shape: value, mouth: icon.mouth, accessory: icon.accessory, color: icon.color)
        case .mouth:
            .init(shape: icon.shape, mouth: value, accessory: icon.accessory, color: icon.color)
        case .accessory:
            .init(shape: icon.shape, mouth: icon.mouth, accessory: value, color: icon.color)
        case .color:
            .init(shape: icon.shape, mouth: icon.mouth, accessory: icon.accessory, color: value)
        }
    }

    func previewIcon(
        index: Int,
        selection: CompanionSummary.Icon
    ) -> CompanionSummary.Icon {
        replacingValue(in: selection, with: index)
    }
}
