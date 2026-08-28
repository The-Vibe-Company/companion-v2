import Foundation
import CompanionKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Owns all transient composer state so typing and attachment preparation do not invalidate the
/// transcript projection. The parent only receives a submitted, already-trimmed payload.
struct ChatComposer: View {
    let companionID: String
    let companionName: String
    let companionIcon: CompanionSummary.Icon?
    let canSend: Bool?
    let transcriptionAvailable: Bool
    let isReplying: Bool
    let hasLiveReasoning: Bool
    let error: String?
    let sending: Bool
    let accent: Color
    let accentForeground: Color
    let canAutomaticallyFocus: () -> Bool
    let onFocusChange: (Bool) -> Void
    let onThinkingTap: () -> Void
    let onSend: (String, [CompanionMessageAttachment]) -> Void

    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft = ""
    @State private var draftAttachments: [CompanionMessageAttachment] = []
    @State private var attachmentError: String?
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showDocumentPicker = false
    @State private var selectingAttachments = false
    @State private var transcription = VoiceTranscriptionController()
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 8) {
            thinkingStatus
            sendErrorMessage
            composerAvailabilityContent
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .accessibilityIdentifier("chat.composer-controls")
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isReplying)
        .onChange(of: photoPickerItems) { _, items in
            guard !items.isEmpty else { return }
            loadSelectedPhotos(items)
        }
        .fileImporter(
            isPresented: $showDocumentPicker,
            allowedContentTypes: Self.allowedDocumentTypes,
            allowsMultipleSelection: true,
            onCompletion: importDocuments
        )
        .onChange(of: companionID) {
            transcription.cancel()
        }
        .onChange(of: canSend) { _, nextCanSend in
            if nextCanSend != true { transcription.cancel() }
        }
        .onChange(of: transcriptionAvailable) { _, available in
            if !available { transcription.cancel() }
        }
        .onChange(of: transcription.completion) { _, completion in
            guard let completion else { return }
            draft = mergedDraft(draft, completion.text)
            if canAutomaticallyFocus() { composerFocused = true }
            transcription.acknowledgeCompletion()
        }
        .onChange(of: composerFocused) { _, focused in
            onFocusChange(focused)
        }
        .onDisappear {
            transcription.cancel()
        }
    }

    @ViewBuilder
    private var thinkingStatus: some View {
        if isReplying {
            CompanionThinkingStatus(
                companionName: companionName,
                icon: companionIcon,
                accent: accent,
                isInteractive: hasLiveReasoning,
                onTap: onThinkingTap
            )
            .transition(
                reduceMotion
                    ? .identity
                    : .move(edge: .bottom).combined(with: .opacity)
            )
        }
    }

    @ViewBuilder
    private var sendErrorMessage: some View {
        if let error {
            Text(error)
                .font(.caption)
                .foregroundStyle(CompanionIOSTheme.danger)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var composerAvailabilityContent: some View {
        if canSend == false {
            Label("This conversation is read-only", systemImage: "eye")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(CompanionIOSTheme.card, in: Capsule())
        } else {
            attachmentStrip
            attachmentErrorMessage
            transcriptionStatus
            inputBar
            attachmentOnlyPrompt
        }
    }

    @ViewBuilder
    private var attachmentStrip: some View {
        if !draftAttachments.isEmpty {
            ComposerAttachmentStrip(
                attachments: draftAttachments,
                onRemove: removeAttachment
            )
            .padding(.horizontal, 2)
        }
    }

    @ViewBuilder
    private var attachmentErrorMessage: some View {
        if let attachmentError {
            Text(attachmentError)
                .font(.caption)
                .foregroundStyle(CompanionIOSTheme.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .accessibilityLabel("Attachment error: \(attachmentError)")
        }
    }

    @ViewBuilder
    private var transcriptionStatus: some View {
        if transcriptionAvailable && (transcription.isBusy || transcriptionFailed) {
            VoiceTranscriptionStatusView(controller: transcription)
                .padding(.horizontal, 2)
        }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 4) {
            Menu {
                Button {
                    presentPhotoLibrary()
                } label: {
                    Label("Photo library", systemImage: "photo.on.rectangle")
                }
                Button {
                    presentDocumentPicker()
                } label: {
                    Label("Choose file", systemImage: "document")
                }
            } label: {
                Group {
                    if selectingAttachments {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "plus")
                    }
                }
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .frame(width: 44, height: 44)
                .background(CompanionIOSTheme.canvas, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(attachDisabled)
            .accessibilityLabel(
                remainingAttachmentCapacity == 0
                    ? "Five files attached"
                    : "Attach a photo or file"
            )
            .accessibilityIdentifier("chat.attach")
            .photosPicker(
                isPresented: $showPhotoPicker,
                selection: $photoPickerItems,
                maxSelectionCount: max(1, remainingAttachmentCapacity),
                matching: .images,
                preferredItemEncoding: .compatible
            )

            TextField("Ask \(companionName)", text: $draft, axis: .vertical)
                .font(.body)
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .lineLimit(1...5)
                .focused($composerFocused)
                .padding(.horizontal, 8)
                .padding(.vertical, 11)
                .accessibilityIdentifier("chat.composer")

            trailingControl
        }
        .padding(4)
        .background(CompanionIOSTheme.card, in: Capsule())
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.2),
            value: showsSendButton
        )
    }

    @ViewBuilder
    private var attachmentOnlyPrompt: some View {
        if !draftAttachments.isEmpty,
           draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text("Add a message to send \(draftAttachments.count == 1 ? "this file" : "these files").")
                .font(.caption)
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        }
    }

    private var sendDisabled: Bool {
        sending
            || selectingAttachments
            || transcription.isBusy
            || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || canSend == false
    }

    private var showsSendButton: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @ViewBuilder
    private var trailingControl: some View {
        if transcription.isBusy {
            transcriptionButton
                .transition(.opacity)
        } else if showsSendButton || !transcriptionAvailable {
            sendButton
                .transition(.opacity)
        } else {
            transcriptionButton
                .transition(.opacity)
        }
    }

    private var sendButton: some View {
        Button(action: send) {
            Group {
                if sending {
                    ProgressView().controlSize(.small).tint(CompanionIOSTheme.primaryCTAText)
                } else {
                    Image(systemName: "arrow.up")
                }
            }
            .font(.system(size: 17, weight: .bold))
            .foregroundStyle(CompanionIOSTheme.primaryCTAText)
            .frame(width: 44, height: 44)
            .background(CompanionIOSTheme.primaryCTA, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(sendDisabled)
        .accessibilityLabel("Send message")
        .accessibilityIdentifier("chat.send")
    }

    private var transcriptionButton: some View {
        Button(action: toggleTranscription) {
            Group {
                if transcription.phase == .requestingPermission
                    || transcription.phase == .processing {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: transcription.isRecording ? "stop.fill" : "mic")
                }
            }
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(
                transcription.isBusy
                    ? CompanionIOSTheme.danger
                    : CompanionIOSTheme.textSecondary
            )
            .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .disabled(transcriptionButtonDisabled)
        .accessibilityLabel(transcriptionButtonLabel)
        .accessibilityValue(transcriptionAccessibilityValue)
        .accessibilityHint(
            transcription.isBusy
                ? "Stops recording and adds the transcript to the message field."
                : "Records speech and sends audio to Google for live transcription."
        )
        .accessibilityIdentifier("chat.transcription.toggle")
    }

    private var attachDisabled: Bool {
        sending
            || selectingAttachments
            || transcription.isBusy
            || remainingAttachmentCapacity == 0
            || canSend == false
    }

    private var transcriptionButtonDisabled: Bool {
        if case .processing = transcription.phase { return true }
        return !transcription.isBusy && (sending || selectingAttachments || canSend != true)
    }

    private var transcriptionFailed: Bool {
        if case .failed = transcription.phase { return true }
        return false
    }

    private var transcriptionButtonLabel: String {
        switch transcription.phase {
        case .requestingPermission:
            "Cancel voice transcription"
        case .recording:
            "Stop recording"
        case .processing:
            "Processing voice transcription"
        case .idle, .failed:
            "Start voice transcription"
        }
    }

    private var transcriptionAccessibilityValue: String {
        switch transcription.phase {
        case .recording:
            "Recording"
        case .requestingPermission:
            "Waiting for microphone permission"
        case .processing:
            "Processing"
        case .failed(let message):
            message
        case .idle:
            "Not recording"
        }
    }

    private func toggleTranscription() {
        composerFocused = false
        if transcription.isBusy {
            transcription.stop()
            return
        }
        guard canSend == true, transcriptionAvailable else { return }
        let targetCompanionID = companionID
        transcription.start { audio in
            try await sessionStore.transcribeCompanionAudio(
                companionID: targetCompanionID,
                audio: audio
            )
        }
    }

    private func mergedDraft(_ current: String, _ transcript: String) -> String {
        let dictated = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return dictated
        }
        guard !dictated.isEmpty else { return current }
        return current + (current.last?.isWhitespace == true ? "" : " ") + dictated
    }

    private var remainingAttachmentCapacity: Int {
        max(0, companionMessageAttachmentMaximumCount - draftAttachments.count)
    }

    private func send() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !sending else { return }
        let attachments = draftAttachments
        draft = ""
        draftAttachments = []
        attachmentError = nil
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        onSend(content, attachments)
    }

    private func removeAttachment(_ id: UUID) {
        draftAttachments.removeAll { $0.id == id }
        attachmentError = nil
    }

    private func presentPhotoLibrary() {
        composerFocused = false
        Task { @MainActor in
            // UIKit must finish dismissing the menu and keyboard before another presenter starts.
            try? await Task.sleep(for: .milliseconds(250))
            showPhotoPicker = true
        }
    }

    private func presentDocumentPicker() {
        composerFocused = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            showDocumentPicker = true
        }
    }

    private func loadSelectedPhotos(_ items: [PhotosPickerItem]) {
        selectingAttachments = true
        attachmentError = nil
        Task {
            var imported: [CompanionMessageAttachment] = []
            var firstError: String?
            for (offset, item) in items.prefix(remainingAttachmentCapacity).enumerated() {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        firstError = firstError ?? "That photo could not be loaded."
                        continue
                    }
                    imported.append(try CompanionMessageAttachment(
                        data: data,
                        filename: "photo-\(draftAttachments.count + offset + 1)",
                        declaredContentType: item.supportedContentTypes.first?.preferredMIMEType
                    ))
                } catch {
                    firstError = firstError ?? attachmentImportMessage(error)
                }
            }
            appendImportedAttachments(imported, firstError: firstError)
            photoPickerItems = []
            selectingAttachments = false
        }
    }

    private func importDocuments(_ result: Result<[URL], Error>) {
        guard case let .success(urls) = result else {
            if case let .failure(error) = result,
               (error as NSError).code != NSUserCancelledError {
                attachmentError = "Files could not be opened."
            }
            return
        }
        selectingAttachments = true
        attachmentError = nil
        let capacity = remainingAttachmentCapacity
        Task {
            let imported = await Task.detached(priority: .userInitiated) {
                Self.readDocuments(Array(urls.prefix(capacity)))
            }.value
            appendImportedAttachments(imported.attachments, firstError: imported.firstError)
            if urls.count > capacity {
                attachmentError = "You can attach up to five files."
            }
            selectingAttachments = false
        }
    }

    private func appendImportedAttachments(
        _ attachments: [CompanionMessageAttachment],
        firstError: String?
    ) {
        let capacity = remainingAttachmentCapacity
        draftAttachments.append(contentsOf: attachments.prefix(capacity))
        if attachments.count > capacity {
            attachmentError = "You can attach up to five files."
        } else {
            attachmentError = firstError
        }
    }

    private func attachmentImportMessage(_ error: Error) -> String {
        if let validation = error as? CompanionMessageAttachmentError {
            return validation.localizedDescription
        }
        return "That file could not be opened."
    }

    private static let allowedDocumentTypes: [UTType] = [
        .pdf,
        .commaSeparatedText,
        .plainText,
        .json,
        UTType(filenameExtension: "md") ?? .plainText,
    ]

    nonisolated private static func readDocuments(_ urls: [URL]) -> AttachmentImportResult {
        var attachments: [CompanionMessageAttachment] = []
        var firstError: String?
        for url in urls {
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            do {
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
                if let size = values.fileSize, size > companionAttachmentMaximumBytes {
                    throw CompanionMessageAttachmentError.tooLarge
                }
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                attachments.append(try CompanionMessageAttachment(
                    data: data,
                    filename: url.lastPathComponent,
                    declaredContentType: values.contentType?.preferredMIMEType
                ))
            } catch {
                if let validation = error as? CompanionMessageAttachmentError {
                    firstError = firstError ?? validation.localizedDescription
                } else {
                    firstError = firstError ?? "That file could not be opened."
                }
            }
        }
        return AttachmentImportResult(attachments: attachments, firstError: firstError)
    }
}

private struct AttachmentImportResult: Sendable {
    let attachments: [CompanionMessageAttachment]
    let firstError: String?
}
