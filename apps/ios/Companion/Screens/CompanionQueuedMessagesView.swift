import CompanionKit
import SwiftUI
import UIKit

struct CompanionQueuedMessagesView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let entries: [TranscriptEntry]
    let canManage: Bool
    let viewerID: String? = nil
    let accent: Color
    let onRemove: (String) async throws -> Void

    @State private var expanded = false
    @State private var removalCandidate: TranscriptEntry?
    @State private var removingTurnID: String?
    @State private var removalError: String?

    var body: some View {
        Group {
            if expanded {
                expandedQueue
            } else {
                collapsedQueue
            }
        }
        .confirmationDialog(
            "Remove queued message?",
            isPresented: removalConfirmationPresented,
            titleVisibility: .visible,
            presenting: removalCandidate
        ) { entry in
            Button("Remove from queue", role: .destructive) {
                remove(entry)
            }
            Button("Keep queued", role: .cancel) { }
        } message: { _ in
            Text("This message will not run.")
        }
        .onChange(of: entries.map(\.eventID)) {
            if entries.isEmpty { expanded = false }
            if let removingTurnID,
               !entries.contains(where: { $0.turnID == removingTurnID }) {
                self.removingTurnID = nil
            }
        }
    }

    @ViewBuilder
    private var collapsedQueue: some View {
        if reduceTransparency {
            queueHeader
                .background(
                    Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(Color(uiColor: .separator), lineWidth: 0.7)
                }
        } else {
            queueHeader.glassEffect(
                Glass.regular.tint(accent.opacity(0.06)).interactive(),
                in: .rect(cornerRadius: 18)
            )
        }
    }

    private var expandedQueue: some View {
        VStack(spacing: 0) {
            queueHeader

            Divider()
                .padding(.horizontal, 14)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(entries) { entry in
                        queueRow(entry)
                        if entry.id != entries.last?.id {
                            Divider().padding(.leading, 14)
                        }
                    }
                }
            }
            .scrollIndicators(.visible)
            .frame(maxHeight: 280)
            .accessibilityIdentifier("chat.queue.list")

            if let removalError {
                Text(removalError)
                    .font(.caption)
                    .foregroundStyle(Color.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
                    .accessibilityLabel("Queue error: \(removalError)")
                    .accessibilityIdentifier("chat.queue.error")
            }
        }
        .background(
            reduceTransparency
                ? AnyShapeStyle(Color(uiColor: .secondarySystemBackground))
                : AnyShapeStyle(.regularMaterial),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color(uiColor: .separator), lineWidth: 0.7)
        }
    }

    private var queueHeader: some View {
        Button(action: toggleExpanded) {
            HStack(spacing: 11) {
                attachmentPeek

                VStack(alignment: .leading, spacing: 2) {
                    Text(queueCountLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.primary)
                    Text(firstPreview)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.secondary)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibleQueueCount)
        .accessibilityValue(firstPreview)
        .accessibilityHint(expanded ? "Double-tap to collapse the queue" : "Double-tap to show the queue")
        .accessibilityIdentifier("chat.queue.toggle")
    }

    @ViewBuilder
    private var attachmentPeek: some View {
        let count = entries.first?.attachments.count ?? 0
        if count > 0 {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: firstAttachmentSymbol)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 36, height: 36)
                    .background(
                        Color(uiColor: .tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 9)
                    )

                Text("\(count)")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 2)
                    .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                    .overlay { Capsule().stroke(Color(uiColor: .separator), lineWidth: 0.7) }
                    .offset(x: 4, y: 4)
            }
            .frame(width: 40, height: 40)
            .accessibilityHidden(true)
        } else {
            Image(systemName: "text.bubble")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.secondary)
                .frame(width: 40, height: 40)
                .accessibilityHidden(true)
        }
    }

    private func queueRow(_ entry: TranscriptEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.content)
                    .font(.subheadline)
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)

                if let attachmentSummary = attachmentSummary(for: entry) {
                    Label(attachmentSummary, systemImage: attachmentSymbol(for: entry))
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibleSummary(for: entry))

            if canManageRemoval(for: entry), let turnID = entry.turnID {
                Button(role: .destructive) {
                    requestRemoval(of: entry)
                } label: {
                    Group {
                        if removingTurnID == turnID {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "trash")
                        }
                    }
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.red)
                .disabled(removingTurnID != nil)
                .accessibilityLabel(removalAccessibilityLabel(for: entry))
                .accessibilityHint("This message will not run")
                .accessibilityIdentifier("chat.queue.remove.\(turnID)")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .contentShape(.rect)
        .contextMenu {
            if canDeleteFromContext(entry) {
                Button("Delete", systemImage: "trash", role: .destructive) {
                    requestRemoval(of: entry)
                }
            }
        }
        .accessibilityIdentifier("chat.queue.item.\(entry.eventID)")
    }

    private var queueCountLabel: String {
        "\(entries.count) queued"
    }

    private var accessibleQueueCount: String {
        "\(entries.count) queued \(entries.count == 1 ? "message" : "messages")"
    }

    private var firstPreview: String {
        guard let first = entries.first else { return "" }
        let text = first.content.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = attachmentSummary(for: first)
        if text.isEmpty { return summary ?? "Queued message" }
        if let summary { return "\(text), \(summary)" }
        return text
    }

    private var firstAttachmentSymbol: String {
        guard let first = entries.first else { return "paperclip" }
        return attachmentSymbol(for: first)
    }

    private func attachmentSymbol(for entry: TranscriptEntry) -> String {
        entry.attachments.contains(where: { $0.contentType.isImage }) ? "photo.on.rectangle" : "doc"
    }

    private func attachmentSummary(for entry: TranscriptEntry) -> String? {
        let images = entry.attachments.count(where: { $0.contentType.isImage })
        let documents = entry.attachments.count - images
        let parts = [
            images > 0 ? "\(images) \(images == 1 ? "image" : "images")" : nil,
            documents > 0 ? "\(documents) \(documents == 1 ? "file" : "files")" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    private func accessibleSummary(for entry: TranscriptEntry) -> String {
        let text = entry.content.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = attachmentSummary(for: entry)
        if text.isEmpty { return "Queued message. \(summary ?? "No attachments")" }
        if let summary { return "Queued message. \(text). \(summary)" }
        return "Queued message. \(text)"
    }

    private func removalAccessibilityLabel(for entry: TranscriptEntry) -> String {
        let text = entry.content.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            return "Delete queued message: \(String(text.prefix(80)))"
        }
        return "Delete queued message with \(attachmentSummary(for: entry) ?? "no attachments")"
    }

    private func canManageRemoval(for entry: TranscriptEntry) -> Bool {
        // Keep the existing Owner/Editor cancel affordance for every contract-valid queued turn.
        canManage && entry.turnID != nil
    }

    private func canDeleteFromContext(_ entry: TranscriptEntry) -> Bool {
        // A long-press Delete is a personal shortcut. The visible cancel control above remains
        // available to every Owner/Editor as in the shared queue contract.
        canManageRemoval(for: entry)
            && removingTurnID == nil
            && entry.role == "user"
            && entry.authorID != nil
            && entry.authorID == viewerID
    }

    private func requestRemoval(of entry: TranscriptEntry) {
        removalError = nil
        removalCandidate = entry
    }

    private var removalConfirmationPresented: Binding<Bool> {
        Binding(
            get: { removalCandidate != nil },
            set: { presented in
                if !presented { removalCandidate = nil }
            }
        )
    }

    private func toggleExpanded() {
        if reduceMotion {
            expanded.toggle()
        } else {
            withAnimation(.easeOut(duration: 0.18)) {
                expanded.toggle()
            }
        }
    }

    private func remove(_ entry: TranscriptEntry) {
        guard removingTurnID == nil, let turnID = entry.turnID else { return }
        removalCandidate = nil
        removingTurnID = turnID
        removalError = nil
        Task {
            do {
                try await onRemove(turnID)
                removingTurnID = nil
            } catch {
                removingTurnID = nil
                removalError = "The message could not be removed. Try again."
            }
        }
    }
}
