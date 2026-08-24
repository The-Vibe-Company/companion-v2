import SwiftUI
import CompanionKit

struct ChatView: View {
    @Environment(SessionStore.self) private var sessionStore
    let companion: CompanionSummary
    @State private var thread: CompanionThread?
    @State private var draft = ""
    @State private var loading = true
    @State private var sending = false
    @State private var error: String?
    @State private var pendingMessages: [PendingMessage] = []
    @State private var reloadGeneration = 0

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    if loading && thread == nil {
                        ProgressView("Loading conversation…").padding(.top, 80)
                    } else if let error, thread == nil {
                        ContentUnavailableView {
                            Label("Conversation unavailable", systemImage: "exclamationmark.bubble")
                        } description: {
                            Text(error)
                        } actions: {
                            Button("Try again") { Task { await reload() } }
                        }
                        .padding(.top, 60)
                    } else if thread?.entries.isEmpty != false && pendingMessages.isEmpty {
                        ContentUnavailableView(
                            "Start the conversation",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("Send the first message to wake \(companion.name).")
                        )
                        .padding(.top, 60)
                    } else {
                        ForEach(thread?.entries ?? []) { entry in
                            MessageEntryView(
                                entry: entry,
                                own: entry.role == "user" && entry.authorID == thread?.viewerID
                            )
                            .id(entry.id)
                        }
                        ForEach(pendingMessages) { pending in
                            PendingMessageView(
                                message: pending,
                                retry: { retry(pending.id) },
                                dismiss: { dismiss(pending.id) }
                            )
                            .id("pending-\(pending.id)")
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 18)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.companionCanvas)
            .safeAreaInset(edge: .bottom) { composer }
            .onChange(of: (thread?.entries.count ?? 0) + pendingMessages.count) {
                withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .navigationTitle(companion.name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: companion.id) {
            await reload()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled { await reload(silently: true) }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let error, thread != nil {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Color.companionDanger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Message \(companion.name)", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 11)
                    .background(Color.companionSurfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .accessibilityIdentifier("chat.composer")
                Button(action: send) {
                    Group {
                        if sending { ProgressView().controlSize(.small) }
                        else { Image(systemName: "arrow.up") }
                    }
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 42, height: 42)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || thread?.canSend == false)
                .accessibilityIdentifier("chat.send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 9)
        .padding(.bottom, 6)
        .background(.bar)
    }

    private func reload(silently: Bool = false) async {
        reloadGeneration += 1
        let generation = reloadGeneration
        if !silently { loading = true }
        do {
            let next = try await sessionStore.thread(companionID: companion.id)
            guard generation == reloadGeneration else { return }
            thread = next
            let persistedEventIDs = Set(next.entries.map(\.eventID))
            pendingMessages.removeAll { pending in
                persistedEventIDs.contains("msg:\(pending.id.uuidString.lowercased())")
            }
            error = nil
        } catch {
            guard generation == reloadGeneration else { return }
            self.error = "The conversation could not be refreshed."
        }
        if generation == reloadGeneration { loading = false }
    }

    private func send() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !sending else { return }
        let message = PendingMessage(id: UUID(), content: content, failed: false)
        pendingMessages.append(message)
        draft = ""
        sending = true
        error = nil
        Task {
            await sendPending(message.id)
            sending = false
        }
    }

    private func retry(_ id: UUID) {
        guard !sending else { return }
        sending = true
        Task {
            await sendPending(id)
            sending = false
        }
    }

    private func dismiss(_ id: UUID) {
        pendingMessages.removeAll { $0.id == id }
    }

    private func sendPending(_ id: UUID) async {
        guard let index = pendingMessages.firstIndex(where: { $0.id == id }) else { return }
        let message = pendingMessages[index]
        pendingMessages[index].failed = false
        error = nil
        do {
            try await sessionStore.sendMessage(
                companionID: companion.id,
                content: message.content,
                clientMessageID: message.id
            )
            pendingMessages.removeAll { $0.id == id }
            await reload(silently: true)
        } catch {
            if let current = pendingMessages.firstIndex(where: { $0.id == id }) {
                pendingMessages[current].failed = true
            }
        }
    }
}

private struct MessageEntryView: View {
    let entry: TranscriptEntry
    let own: Bool

    var body: some View {
        HStack {
            if own { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 5) {
                if !own {
                    Text(entry.authorName ?? (entry.role == "user" ? "Workspace member" : "Companion"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.companionMuted)
                }
                Text(entry.content)
                    .font(.body)
                    .textSelection(.enabled)
                if entry.queued {
                    Text("Queued")
                        .font(.caption2)
                        .foregroundStyle(Color.companionMuted)
                }
            }
            .padding(entry.role == "user" ? 12 : 0)
            .background(messageBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .frame(maxWidth: entry.role == "user" ? 340 : .infinity, alignment: .leading)
            if !own { Spacer(minLength: 28) }
        }
        .frame(maxWidth: .infinity)
    }

    private var messageBackground: Color {
        if own { return Color.companionAccent.opacity(0.18) }
        if entry.role == "user" { return Color.companionSurface }
        return Color.clear
    }
}

private struct PendingMessage: Identifiable, Equatable {
    let id: UUID
    let content: String
    var failed: Bool
}

private struct PendingMessageView: View {
    let message: PendingMessage
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .leading, spacing: 7) {
                Text(message.content)
                    .font(.body)
                    .textSelection(.enabled)
                if message.failed {
                    Text("Delivery could not be confirmed. Retrying reuses the same request.")
                        .font(.caption2)
                        .foregroundStyle(Color.companionDanger)
                    HStack(spacing: 12) {
                        Button("Retry", action: retry)
                        Button("Dismiss", action: dismiss)
                            .foregroundStyle(Color.companionMuted)
                    }
                    .font(.caption.weight(.semibold))
                } else {
                    Text("Sending…")
                        .font(.caption2)
                        .foregroundStyle(Color.companionMuted)
                }
            }
            .padding(12)
            .background(Color.companionAccent.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .frame(maxWidth: 340, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
    }
}
