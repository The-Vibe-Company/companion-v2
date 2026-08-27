import CompanionKit
import ImageIO
import QuickLook
import SwiftUI
import UIKit

func attachmentSizeLabel(_ bytes: Int) -> String {
    let formatter = ByteCountFormatter()
    formatter.allowedUnits = bytes < 1_024 * 1_024 ? [.useBytes, .useKB] : [.useMB]
    formatter.countStyle = .file
    formatter.includesUnit = true
    formatter.isAdaptive = true
    return formatter.string(fromByteCount: Int64(bytes))
}

struct ComposerAttachmentStrip: View {
    let attachments: [CompanionMessageAttachment]
    let onRemove: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    if attachment.contentType.isImage {
                        composerImage(attachment)
                    } else {
                        documentChip(attachment)
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollIndicators(.hidden)
        .accessibilityLabel("\(attachments.count) file\(attachments.count == 1 ? "" : "s") attached")
    }

    private func composerImage(_ attachment: CompanionMessageAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            LocalAttachmentImage(data: attachment.data, maximumPixelSize: 160)
                .frame(width: 64, height: 64)
                .background(Color.companionSurfaceRaised)
                .clipShape(.rect(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.companionDivider, lineWidth: 1)
                }
                .accessibilityLabel(attachment.filename)

            removeButton(attachment)
                .offset(x: 10, y: -10)
        }
        .padding(.top, 10)
        .padding(.trailing, 10)
    }

    private func documentChip(_ attachment: CompanionMessageAttachment) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "doc")
                .foregroundStyle(Color.companionMuted)
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.filename)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                Text(attachmentSizeLabel(attachment.byteSize))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.companionMuted)
            }
            removeButton(attachment)
        }
        .padding(.leading, 10)
        .padding(.vertical, 4)
        .padding(.trailing, 4)
        .frame(maxWidth: 260)
        .companionMaterial(radius: 10)
    }

    private func removeButton(_ attachment: CompanionMessageAttachment) -> some View {
        Button {
            onRemove(attachment.id)
        } label: {
            Image(systemName: "xmark")
                .font(.caption2.weight(.bold))
                .frame(width: 24, height: 24)
                .background(Color.companionCanvas, in: Circle())
                .overlay { Circle().stroke(Color.companionDivider, lineWidth: 1) }
                .frame(width: 44, height: 44)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Remove \(attachment.filename)")
    }
}

struct LocalMessageAttachmentList: View {
    let attachments: [CompanionMessageAttachment]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(attachments) { attachment in
                if attachment.contentType.isImage {
                    LocalAttachmentImage(data: attachment.data, maximumPixelSize: 640)
                        .frame(minHeight: 112, maxHeight: 220)
                        .frame(maxWidth: .infinity)
                        .background(Color.companionSurfaceRaised)
                        .clipShape(.rect(cornerRadius: 10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(Color.companionDivider, lineWidth: 1)
                        }
                        .accessibilityLabel(attachment.filename)
                } else {
                    AttachmentDocumentCard(
                        filename: attachment.filename,
                        byteSize: attachment.byteSize,
                        subtitle: "Attachment"
                    )
                }
            }
        }
    }
}

struct TranscriptAttachmentList: View {
    @Environment(SessionStore.self) private var sessionStore
    let companionID: String
    let attachments: [CompanionAttachment]
    @State private var previewURL: URL?
    @State private var openingAttachmentID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(attachments.sorted { $0.position < $1.position }) { attachment in
                if attachment.contentType.isImage {
                    RemoteAttachmentImage(companionID: companionID, attachment: attachment)
                } else {
                    Button {
                        Task { await open(attachment) }
                    } label: {
                        AttachmentDocumentCard(
                            filename: attachment.filename,
                            byteSize: attachment.byteSize,
                            subtitle: "Companion",
                            loading: openingAttachmentID == attachment.id
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(openingAttachmentID != nil)
                    .accessibilityHint("Opens a file preview")
                    .accessibilityIdentifier("attachment.open.\(attachment.id)")
                }
            }
        }
        .quickLookPreview($previewURL)
        .onDisappear { removePreviewFile() }
    }

    @MainActor
    private func open(_ attachment: CompanionAttachment) async {
        openingAttachmentID = attachment.id
        defer { openingAttachmentID = nil }
        do {
            let data = try await sessionStore.attachmentData(
                companionID: companionID,
                attachmentID: attachment.id
            )
            guard !Task.isCancelled else { return }
            removePreviewFile()
            let safeName = URL(fileURLWithPath: attachment.filename).lastPathComponent
            let url = FileManager.default.temporaryDirectory
                .appending(path: "companion-preview-\(UUID().uuidString)", directoryHint: .isDirectory)
                .appending(path: safeName)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            previewURL = url
        } catch is CancellationError {
            return
        } catch {
            return
        }
    }

    private func removePreviewFile() {
        guard let previewURL else { return }
        try? FileManager.default.removeItem(at: previewURL.deletingLastPathComponent())
        self.previewURL = nil
    }
}

private struct AttachmentDocumentCard: View {
    let filename: String
    let byteSize: Int
    let subtitle: String
    var loading = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.text.fill")
                .font(.system(size: 18))
                .foregroundStyle(Color.companionInk)
                .frame(width: 36, height: 36)
                .background(Color.companionSurfaceRaised, in: RoundedRectangle(cornerRadius: 9))

            VStack(alignment: .leading, spacing: 2) {
                Text(filename)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.companionInk)
                    .lineLimit(1)
                Text("\(subtitle) · \(attachmentSizeLabel(byteSize))")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.companionMuted)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if loading {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
            }
        }
        .padding(10)
        .frame(maxWidth: 320, alignment: .leading)
        .background(Color.companionCanvas, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

private struct LocalAttachmentImage: View {
    let data: Data
    let maximumPixelSize: CGFloat
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "photo")
                    .foregroundStyle(Color.companionMuted)
            }
        }
        .task(id: data) {
            image = downsampledImage(data, maximumPixelSize: maximumPixelSize)
        }
    }
}

private struct RemoteAttachmentImage: View {
    @Environment(SessionStore.self) private var sessionStore
    let companionID: String
    let attachment: CompanionAttachment
    @State private var image: UIImage?
    @State private var failed = false
    @State private var loadGeneration = 0

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if failed {
                Button {
                    loadGeneration += 1
                } label: {
                    VStack(spacing: 6) {
                        Image(systemName: "photo.badge.exclamationmark")
                        Text("Image unavailable")
                            .font(.caption)
                        Text("Try again")
                            .font(.caption2.weight(.semibold))
                    }
                    .foregroundStyle(Color.companionMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(attachment.filename) unavailable. Try again")
            } else {
                ProgressView("Loading image")
                    .font(.caption)
                    .foregroundStyle(Color.companionMuted)
            }
        }
        .frame(minHeight: 112, maxHeight: 220)
        .frame(maxWidth: .infinity)
        .background(Color.companionSurfaceRaised)
        .clipShape(.rect(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.companionDivider, lineWidth: 1)
        }
        .accessibilityLabel(attachment.filename)
        .task(id: loadGeneration) {
            failed = false
            do {
                let data = try await sessionStore.attachmentData(
                    companionID: companionID,
                    attachmentID: attachment.id
                )
                guard !Task.isCancelled,
                      let decoded = downsampledImage(data, maximumPixelSize: 1_280) else {
                    if !Task.isCancelled { failed = true }
                    return
                }
                image = decoded
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}

private func downsampledImage(_ data: Data, maximumPixelSize: CGFloat) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
        kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        return nil
    }
    return UIImage(cgImage: image)
}
