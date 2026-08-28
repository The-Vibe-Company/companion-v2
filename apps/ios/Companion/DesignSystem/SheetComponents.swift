import SwiftUI

struct CompanionSheetCanvas<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ZStack {
            CompanionIOSTheme.canvas.ignoresSafeArea()
            content
        }
    }
}

struct CompanionSheetHeader<Trailing: View>: View {
    enum LeadingStyle: Equatable {
        case close
        case back
    }

    let title: String
    let leadingStyle: LeadingStyle
    let leadingAction: () -> Void
    let trailing: Trailing

    init(
        title: String,
        leadingStyle: LeadingStyle,
        leadingAction: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.leadingStyle = leadingStyle
        self.leadingAction = leadingAction
        self.trailing = trailing()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Button(action: leadingAction) {
                    Image(systemName: leadingStyle == .close ? "xmark" : "chevron.left")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .background(CompanionIOSTheme.card, in: Circle())
                        .overlay {
                            Circle().stroke(CompanionIOSTheme.separator, lineWidth: 1)
                        }
                }
                .buttonStyle(.plain)
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .accessibilityLabel(leadingStyle == .close ? "Close" : "Back")
                .accessibilityIdentifier(
                    leadingStyle == .close ? "navigation.close" : "navigation.custom-back"
                )

                Spacer(minLength: 12)
                trailing
            }

            Text(title)
                .font(.system(size: 32, weight: .bold))
                .foregroundStyle(CompanionIOSTheme.textPrimary)
        }
        // Hiding SwiftUI's navigation bar also disables UIKit's interactive pop gesture.
        // Keep the native edge transition beside the custom, accessible back control on every
        // pushed sheet-style destination; modal roots use `.close` and remain dismiss-only.
        .companionNavigationSwipeBackEnabled(leadingStyle == .back)
    }
}

extension CompanionSheetHeader where Trailing == EmptyView {
    init(title: String, leadingStyle: LeadingStyle, leadingAction: @escaping () -> Void) {
        self.init(
            title: title,
            leadingStyle: leadingStyle,
            leadingAction: leadingAction,
            trailing: { EmptyView() }
        )
    }
}

struct CompanionSheetCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct CompanionSheetSection<Content: View>: View {
    let title: String?
    let content: Content

    init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .padding(.horizontal, 4)
            }
            content
        }
    }
}

struct CompanionSheetSeparator: View {
    var leading: CGFloat = 16

    var body: some View {
        Rectangle()
            .fill(CompanionIOSTheme.separator)
            .frame(height: 0.5)
            .padding(.leading, leading)
    }
}

struct CompanionSheetValueRow: View {
    let title: String
    var detail: String?
    var value: String?
    var symbol: String?
    var showsChevron = true

    var body: some View {
        HStack(spacing: 12) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 18))
                    .frame(width: 24)
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                if let detail {
                    Text(detail)
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .font(.system(size: 15))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: detail == nil ? 56 : 72)
        .contentShape(Rectangle())
    }
}

struct CompanionSheetToggleRow: View {
    let title: String
    var detail: String?
    @Binding var isOn: Bool

    var body: some View {
        HStack(alignment: detail == nil ? .center : .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                if let detail {
                    Text(detail)
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            Toggle(title, isOn: $isOn)
                .labelsHidden()
                .tint(CompanionIOSTheme.toggleGreen)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, detail == nil ? 6 : 12)
        .frame(minHeight: detail == nil ? 56 : 76)
    }
}

struct CompanionAccountAvatar: View {
    let name: String

    var body: some View {
        Text(initials)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(CompanionIOSTheme.primaryCTAText)
            .frame(width: 44, height: 44)
            .background(CompanionIOSTheme.primaryCTA, in: Circle())
            .accessibilityHidden(true)
    }

    private var initials: String {
        let parts = name.split(whereSeparator: \.isWhitespace).prefix(2)
        let value = parts.compactMap(\.first).map(String.init).joined()
        return value.isEmpty ? "C" : value.uppercased()
    }
}
