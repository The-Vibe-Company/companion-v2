import SwiftUI
import CompanionKit

struct CompanionManagementHeader: View {
    let eyebrow: String
    let title: String
    let detail: String
    let symbol: String

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: symbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.companionAccent)
                .frame(width: 48, height: 48)
                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
                }

            VStack(alignment: .leading, spacing: 4) {
                Text(eyebrow)
                    .font(.system(size: 13))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                Text(title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Color.companionInk)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .companionGlass(radius: 18)
    }
}

struct CompanionManagementCard<Content: View>: View {
    let title: String?
    let content: Content

    init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let title {
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .companionGlass(radius: 18)
    }
}

struct CompanionFieldLabel: View {
    let title: String
    let detail: String?

    init(_ title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.companionInk)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(Color.companionMuted)
            }
        }
    }
}

struct CompanionErrorNotice: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote.weight(.medium))
            .foregroundStyle(Color.companionDanger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .companionMaterial(radius: 12)
            .accessibilityLabel("Error. \(message)")
    }
}

struct CompanionSuccessNotice: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "checkmark.circle.fill")
            .font(.footnote.weight(.medium))
            .foregroundStyle(Color.companionSuccess)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.companionSuccess.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct CompanionWarningNotice: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(.footnote.weight(.medium))
            .foregroundStyle(Color.companionWarning)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.companionWarning.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityLabel("Warning. \(message)")
    }
}

struct CompanionEmptyCard: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(Color.companionMuted)
            Text(title)
                .font(.headline)
                .foregroundStyle(Color.companionInk)
            Text(detail)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.companionMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
        .padding(.horizontal, 18)
        .companionGlass(radius: 18)
    }
}

func companionDisplayMessage(_ error: Error, fallback: String) -> String {
    if let apiError = error as? APIError, !apiError.message.isEmpty { return apiError.message }
    return fallback
}
