import SwiftUI
import CompanionKit
import ImageIO
import UIKit

/// A compact transcript entry point for one durable Pi tool run.
///
/// Tool payloads are untrusted transcript text. The detail sheet renders them literally and never
/// interprets them as Markdown or HTML. A stable screen ancestor owns detail presentation so row
/// recycling and transcript polling cannot dismiss the reader's current operation.
struct CompanionToolRunCard: View {
    let tool: CompanionToolRun
    let eventID: String
    let onOpenDetails: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var previewImage: UIImage?

    var body: some View {
        Button {
            onOpenDetails()
        } label: {
            summaryRow
        }
        .buttonStyle(.plain)
        .background { cardBackground }
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(borderColor, lineWidth: isFailure ? 1 : 0.7)
        }
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("Double tap to view tool details.")
        .accessibilityIdentifier("tool-run.open-details.\(eventID)")
        .task(id: tool.screenshot) {
            previewImage = ToolRunScreenshotCache.image(from: tool.screenshot)
        }
    }

    @ViewBuilder
    private var summaryRow: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .center, spacing: 10) {
                    familyIcon
                    titleStack
                    openIndicator
                }

                HStack(spacing: 10) {
                    statusView
                    if previewImage != nil { previewBadge }
                }
                .padding(.leading, 38)
            }
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        } else {
            HStack(alignment: .center, spacing: 10) {
                familyIcon
                titleStack
                Spacer(minLength: 4)
                statusView
                if let previewImage { previewThumbnail(previewImage) }
                openIndicator
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
        }
    }

    private var familyIcon: some View {
        Image(systemName: tool.kind.systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color(uiColor: .secondaryLabel))
            .frame(width: 28, height: 28)
            .background(
                Color(uiColor: .tertiarySystemFill),
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .accessibilityHidden(true)
    }

    private var titleStack: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(summaryTitle)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(uiColor: .label))
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                .truncationMode(.middle)

            if !tool.name.isEmpty, tool.name != summaryTitle {
                Text(tool.name)
                    .font(.caption)
                    .foregroundStyle(Color(uiColor: .secondaryLabel))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    .truncationMode(.middle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusView: some View {
        ToolRunStatusView(status: tool.status, reduceMotion: reduceMotion)
    }

    private func previewThumbnail(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: 48, height: 34)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color(uiColor: .separator), lineWidth: 0.7)
            }
            .accessibilityHidden(true)
    }

    private var previewBadge: some View {
        Label("Preview", systemImage: "photo")
            .font(.caption.weight(.medium))
            .foregroundStyle(Color(uiColor: .secondaryLabel))
            .accessibilityHidden(true)
    }

    private var openIndicator: some View {
        Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color(uiColor: .tertiaryLabel))
            .frame(width: 28, height: 44)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(
                reduceTransparency
                    ? AnyShapeStyle(Color(uiColor: .secondarySystemBackground))
                    : AnyShapeStyle(.thinMaterial)
            )
            .overlay {
                if isFailure {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(statusColor.opacity(0.08))
                }
            }
    }

    private var summaryTitle: String {
        tool.displayTitle
    }

    private var accessibilitySummary: String {
        let name = tool.name.isEmpty ? "unnamed tool" : tool.name
        return "\(tool.kind.label) tool, \(summaryTitle), \(name)"
    }

    private var accessibilityValue: String {
        previewImage == nil
            ? tool.status.label
            : "\(tool.status.label). Preview available."
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
        tool.status.color
    }
}

struct ToolRunDetailRoute: Identifiable {
    let id: String
    let tool: CompanionToolRun
    let timestamp: String?
}

struct CompanionToolRunDetailView: View {
    let tool: CompanionToolRun
    let timestamp: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    @State private var screenshotImage: UIImage?
    @State private var screenshotLoaded = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    operationHeader

                    if tool.screenshot != nil {
                        screenshotSection
                    }

                    detailSection
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 18)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Tool details")
            .navigationBarTitleDisplayMode(.inline)
            .accessibilityIdentifier("tool-run.detail")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("tool-run.detail.done")
                }
            }
            .task(id: tool.screenshot) {
                screenshotLoaded = false
                screenshotImage = ToolRunScreenshotCache.image(from: tool.screenshot)
                screenshotLoaded = true
            }
        }
    }

    private var operationHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(tool.kind.label, systemImage: tool.kind.systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color(uiColor: .secondaryLabel))

            Text(tool.displayTitle)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color(uiColor: .label))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("tool-run.detail.title")

            VStack(alignment: .leading, spacing: 4) {
                Text("Tool")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(uiColor: .secondaryLabel))

                Text(tool.name.isEmpty ? "Unnamed tool" : tool.name)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(Color(uiColor: .label))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("tool-run.detail.name")
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) { operationMetadata }
                VStack(alignment: .leading, spacing: 8) { operationMetadata }
            }
        }
    }

    @ViewBuilder
    private var operationMetadata: some View {
        ToolRunStatusView(status: tool.status, reduceMotion: reduceMotion)
            .accessibilityIdentifier("tool-run.detail.status")

        if let timestamp, !timestamp.isEmpty {
            Label(timestamp, systemImage: "clock")
                .font(.caption)
                .foregroundStyle(Color(uiColor: .secondaryLabel))
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityLabel("Recorded \(timestamp)")
                .accessibilityIdentifier("tool-run.detail.timestamp")
        }
    }

    @ViewBuilder
    private var screenshotSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Preview")
                .font(.headline)
                .foregroundStyle(Color(uiColor: .label))

            if let screenshotImage {
                Image(uiImage: screenshotImage)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .background(
                        Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color(uiColor: .separator), lineWidth: 0.7)
                    }
                    .accessibilityLabel("Screenshot preview from \(tool.name.isEmpty ? tool.kind.label : tool.name)")
                    .accessibilityIdentifier("tool-run.detail.screenshot")
            } else if screenshotLoaded {
                Text("Preview unavailable.")
                    .font(.subheadline)
                    .foregroundStyle(Color(uiColor: .secondaryLabel))
                    .accessibilityIdentifier("tool-run.detail.preview-unavailable")
            } else {
                ProgressView("Loading preview…")
                    .accessibilityIdentifier("tool-run.detail.preview-loading")
            }
        }
    }

    private var detailSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Details")
                .font(.headline)
                .foregroundStyle(Color(uiColor: .label))

            if let detail = tool.detail, !detail.isEmpty {
                Text(detail)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(Color(uiColor: .label))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(14)
                    .background(
                        Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color(uiColor: .separator), lineWidth: 0.7)
                    }
                    .accessibilityIdentifier("tool-run.detail.payload")
            } else {
                Text("No detail payload was recorded for this operation.")
                    .font(.subheadline)
                    .foregroundStyle(Color(uiColor: .secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("tool-run.detail.empty")
            }
        }
    }
}

private struct ToolRunStatusView: View {
    let status: CompanionToolRunStatus
    let reduceMotion: Bool

    var body: some View {
        HStack(spacing: 5) {
            if status == .running, !reduceMotion {
                ProgressView()
                    .controlSize(.small)
                    .tint(status.color)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: status.systemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(status.color)
                    .accessibilityHidden(true)
            }

            Text(status.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(uiColor: .label))
                .lineLimit(1)
        }
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(status.label)")
    }
}

@MainActor
private enum ToolRunScreenshotCache {
    /// Mirrors `COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS` at the shared contract boundary.
    private static let maximumDataURLCharacters = 196_608
    private static let maximumPixelDimension = 2_048

    private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 16
        cache.totalCostLimit = 4 * 1_024 * 1_024
        return cache
    }()

    static func image(from dataURL: String?) -> UIImage? {
        guard let dataURL,
              dataURL.count <= maximumDataURLCharacters,
              let comma = dataURL.firstIndex(of: ","),
              ["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"]
                  .contains(String(dataURL[..<comma])) else { return nil }
        let key = dataURL as NSString
        if let cached = images.object(forKey: key) { return cached }

        let encoded = String(dataURL[dataURL.index(after: comma)...])
        guard let data = Data(base64Encoded: encoded),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maximumPixelDimension,
              ] as CFDictionary) else { return nil }
        let image = UIImage(cgImage: cgImage)
        images.setObject(image, forKey: key, cost: cgImage.bytesPerRow * cgImage.height)
        return image
    }
}

private extension CompanionToolRun {
    var displayTitle: String {
        let title = self.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty { return title }
        return name.isEmpty ? kind.label : name
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

    var color: Color {
        switch self {
        case .running: return Color(uiColor: .systemBlue)
        case .ok: return Color(uiColor: .systemGreen)
        case .error: return Color(uiColor: .systemRed)
        case .timeout: return Color(uiColor: .systemOrange)
        }
    }
}
