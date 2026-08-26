import SwiftUI
import CompanionKit
import UIKit

/// A compact transcript projection for one durable Pi tool run.
///
/// Tool payloads are untrusted transcript text. They stay literal and selectable; this view never
/// interprets them as Markdown or HTML. The card's state is local to the row, so polling a newer
/// transcript does not unexpectedly open a disclosure the reader had collapsed.
struct CompanionToolRunCard: View {
    let tool: CompanionToolRun

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var isDisclosureOpen = false
    @State private var isShowingFullDetail = false

    private static let previewCharacterLimit = 1_200
    private static let previewLineLimit = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if hasExpandablePayload {
                Button(action: toggleDetail) {
                    summaryRow
                }
                .buttonStyle(.plain)
                .accessibilityLabel(accessibilitySummary)
                .accessibilityValue(isDisclosureOpen ? "Expanded" : "Collapsed")
                .accessibilityHint(isDisclosureOpen ? "Double tap to hide tool details." : "Double tap to show tool details.")
                .accessibilityIdentifier("tool-run.disclosure")
            } else {
                summaryRow
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(accessibilitySummary)
            }

            if isDisclosureOpen, hasExpandablePayload {
                detailSection
            }
        }
        .background { cardBackground }
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(borderColor, lineWidth: isFailure ? 1 : 0.7)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var summaryRow: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .center, spacing: 10) {
                        familyIcon
                        titleStack
                        disclosureIndicator
                    }
                    statusView
                        .padding(.leading, 38)
                }
                .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            } else {
                HStack(alignment: .center, spacing: 10) {
                    familyIcon
                    titleStack
                    Spacer(minLength: 4)
                    statusView
                    disclosureIndicator
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    private var familyIcon: some View {
        Image(systemName: tool.kind.systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color(uiColor: .secondaryLabel))
            .frame(width: 28, height: 28)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }

    private var titleStack: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(summaryTitle)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(uiColor: .label))
                .lineLimit(1)
                .truncationMode(.middle)

            if !tool.name.isEmpty, tool.name != summaryTitle {
                Text(tool.name)
                    .font(.caption)
                    .foregroundStyle(Color(uiColor: .secondaryLabel))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var disclosureIndicator: some View {
        if hasExpandablePayload {
            Image(systemName: isDisclosureOpen ? "chevron.down" : "chevron.forward")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(uiColor: .secondaryLabel))
                .frame(width: 44, height: 44)
                .accessibilityHidden(true)
        }
    }

    private var statusView: some View {
        HStack(spacing: 5) {
            if tool.status == .running, !reduceMotion {
                ProgressView()
                    .controlSize(.small)
                    .tint(statusColor)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: tool.status.systemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
                    .accessibilityHidden(true)
            }

            Text(tool.status.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(uiColor: .label))
                .lineLimit(1)
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private var detailSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
                .overlay(Color(uiColor: .separator))

            if let detail = tool.detail, !detail.isEmpty {
                Text(displayedDetail(detail))
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Color(uiColor: .label))
                    .lineLimit(isLongDetail && !isShowingFullDetail ? Self.previewLineLimit : nil)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                if isLongDetail {
                    Button(action: toggleDetailPreview) {
                        Label(
                            isShowingFullDetail ? "Show less" : "Show more",
                            systemImage: isShowingFullDetail ? "chevron.up" : "chevron.down"
                        )
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel(isShowingFullDetail ? "Show less detail" : "Show more detail")
                    .accessibilityIdentifier("tool-run.show-more")
                }
            }

            if let image = screenshotImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 240)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .accessibilityLabel("Screenshot from \(tool.name)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
    }

    @ViewBuilder
    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(reduceTransparency ? AnyShapeStyle(Color(uiColor: .secondarySystemBackground)) : AnyShapeStyle(.thinMaterial))
            .overlay {
                if isFailure {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(statusColor.opacity(0.08))
                }
            }
    }

    private var summaryTitle: String {
        let title = tool.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? tool.name : title
    }

    private var hasDetail: Bool {
        guard let detail = tool.detail else { return false }
        return !detail.isEmpty
    }

    private var hasExpandablePayload: Bool {
        hasDetail || screenshotImage != nil
    }

    private var isLongDetail: Bool {
        guard let detail = tool.detail else { return false }
        return detail.count > Self.previewCharacterLimit || detail.split(separator: "\n", omittingEmptySubsequences: false).count > Self.previewLineLimit
    }

    private func displayedDetail(_ detail: String) -> String {
        guard isLongDetail, !isShowingFullDetail else { return detail }
        return String(detail.prefix(Self.previewCharacterLimit))
    }

    private func toggleDetail() {
        if isDisclosureOpen {
            isShowingFullDetail = false
        }
        if reduceMotion {
            isDisclosureOpen.toggle()
        } else {
            withAnimation(.easeInOut(duration: 0.18)) {
                isDisclosureOpen.toggle()
            }
        }
    }

    private func toggleDetailPreview() {
        if reduceMotion {
            isShowingFullDetail.toggle()
        } else {
            withAnimation(.easeInOut(duration: 0.18)) {
                isShowingFullDetail.toggle()
            }
        }
    }

    private var accessibilitySummary: String {
        let family = tool.kind.label
        let name = tool.name.isEmpty ? "unnamed tool" : tool.name
        return "\(family) tool, \(summaryTitle), \(name), \(tool.status.label)."
    }

    private var isFailure: Bool {
        tool.status == .error || tool.status == .timeout
    }

    private var borderColor: Color {
        switch tool.status {
        case .error: return Color(uiColor: .systemRed)
        case .timeout: return Color(uiColor: .systemOrange)
        case .running, .ok: return Color(uiColor: .separator)
        }
    }

    private var statusColor: Color {
        switch tool.status {
        case .running: return Color(uiColor: .systemBlue)
        case .ok: return Color(uiColor: .systemGreen)
        case .error: return Color(uiColor: .systemRed)
        case .timeout: return Color(uiColor: .systemOrange)
        }
    }

    private var screenshotImage: UIImage? {
        ToolRunScreenshotCache.image(from: tool.screenshot)
    }
}

private enum ToolRunScreenshotCache {
    private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 16
        cache.totalCostLimit = 4 * 1_024 * 1_024
        return cache
    }()

    static func image(from dataURL: String?) -> UIImage? {
        guard let dataURL,
              let comma = dataURL.firstIndex(of: ","),
              ["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"]
                  .contains(String(dataURL[..<comma])) else { return nil }
        let key = dataURL as NSString
        if let cached = images.object(forKey: key) { return cached }

        let encoded = String(dataURL[dataURL.index(after: comma)...])
        guard let data = Data(base64Encoded: encoded),
              let image = UIImage(data: data) else { return nil }
        images.setObject(image, forKey: key, cost: data.count)
        return image
    }
}

private extension CompanionToolRunKind {
    var label: String {
        switch self {
        case .shell: return "Shell"
        case .file: return "File"
        case .browse: return "Browse"
        case .computer: return "Computer"
        case .subagent: return "Subagent"
        case .tool: return "Tool"
        }
    }

    var systemImage: String {
        switch self {
        case .shell: return "terminal"
        case .file: return "doc.text"
        case .browse: return "globe"
        case .computer: return "desktopcomputer"
        case .subagent: return "person.2"
        case .tool: return "wrench.and.screwdriver"
        }
    }
}

private extension CompanionToolRunStatus {
    var label: String {
        switch self {
        case .running: return "Running"
        case .ok: return "Done"
        case .error: return "Failed"
        case .timeout: return "Timed out"
        }
    }

    var systemImage: String {
        switch self {
        case .running: return "arrow.triangle.2.circlepath"
        case .ok: return "checkmark.circle.fill"
        case .error: return "exclamationmark.octagon.fill"
        case .timeout: return "clock.badge.exclamationmark.fill"
        }
    }
}
