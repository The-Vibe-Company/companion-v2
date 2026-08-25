import SwiftUI
import CompanionKit

struct ChatView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let companion: CompanionSummary
    let onSettings: () -> Void
    @State private var currentCompanion: CompanionSummary
    @State private var thread: CompanionThread?
    @State private var draft = ""
    @State private var loading = true
    @State private var sending = false
    @State private var error: String?
    @State private var pendingMessages: [PendingMessage] = []
    @State private var markdownByEventID: [String: CachedMarkdownDocument] = [:]
    @State private var reloadGeneration = 0

    init(companion: CompanionSummary, onSettings: @escaping () -> Void) {
        self.companion = companion
        self.onSettings = onSettings
        _currentCompanion = State(initialValue: companion)
    }

    var body: some View {
        CompanionBackdrop(style: .companion(visualTheme.base)) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 16) {
                        if currentCompanion.runtime.replying {
                            replyingBanner
                        }

                        if loading && thread == nil {
                            ProgressView("Loading conversation…")
                                .padding(.top, 80)
                        } else if let error, thread == nil {
                            unavailableState(error)
                        } else if thread?.entries.isEmpty != false && pendingMessages.isEmpty {
                            emptyState
                        } else {
                            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                                if startsNewDay(entry, after: index > 0 ? entries[index - 1] : nil) {
                                    dayMarker(for: transcriptDate(entry.createdAt) ?? .now)
                                }
                                MessageEntryView(
                                    entry: entry,
                                    own: entry.role == "user" && entry.authorID == thread?.viewerID,
                                    companion: currentCompanion,
                                    accent: visualTheme.accent,
                                    markdown: markdownByEventID[entry.eventID]?.document
                                )
                                .id(entry.id)
                            }

                            if !pendingMessages.isEmpty, pendingStartsNewDay {
                                dayMarker(for: .now)
                            }

                            ForEach(pendingMessages) { pending in
                                PendingMessageView(
                                    message: pending,
                                    accent: visualTheme.accent,
                                    accentForeground: visualTheme.accentForeground,
                                    retry: { retry(pending.id) },
                                    dismiss: { dismiss(pending.id) }
                                )
                                .id("pending-\(pending.id)")
                            }
                        }

                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, 22)
                }
                .scrollDismissesKeyboard(.interactively)
                .scrollIndicators(.hidden)
                .safeAreaInset(edge: .bottom) { composer }
                .onChange(of: (thread?.entries.count ?? 0) + pendingMessages.count) {
                    if reduceMotion {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    } else {
                        withAnimation(.easeOut(duration: 0.18)) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { headerToolbar }
        .tint(visualTheme.accent)
        .task(id: companion.id) {
            await reload()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled { await reload(silently: true) }
            }
        }
        .onChange(of: companion) { currentCompanion = companion }
    }

    @ToolbarContentBuilder
    private var headerToolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            HStack(spacing: 9) {
                CompanionAvatar(
                    name: currentCompanion.name,
                    icon: currentCompanion.icon,
                    size: 32,
                    state: currentCompanion.runtime.replying ? .thinking : .idle
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(currentCompanion.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.companionInk)
                        .lineLimit(1)
                    Text(statusLabel)
                        .font(.caption2)
                        .foregroundStyle(Color.companionMuted)
                }
            }
            .accessibilityElement(children: .combine)
        }

        ToolbarItem(placement: .topBarTrailing) {
            CompanionStatusBadge(
                runtime: currentCompanion.runtime,
                compact: true,
                replyingColor: visualTheme.accent
            )
        }

        ToolbarItem(placement: .topBarTrailing) {
            Button(action: onSettings) {
                Image(systemName: "gearshape")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Settings for \(currentCompanion.name)")
            .accessibilityIdentifier("chat.settings")
        }
    }

    private var replyingBanner: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .tint(visualTheme.accent)
            Text("\(currentCompanion.name) is replying…")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.companionInk.opacity(0.76))
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .companionGlass(radius: 18)
        .accessibilityElement(children: .combine)
    }

    private func dayMarker(for date: Date) -> some View {
        Text(dayLabel(for: date))
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.companionMuted)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.thinMaterial, in: Capsule())
            .accessibilityAddTraits(.isHeader)
    }

    private func unavailableState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Conversation unavailable", systemImage: "exclamationmark.bubble")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await reload() } }
                .buttonStyle(.glassProminent)
        }
        .padding(.top, 60)
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            CompanionAvatar(name: currentCompanion.name, icon: currentCompanion.icon, size: 76, state: .idle)
            VStack(spacing: 6) {
                Text("Start the conversation")
                    .font(.title3.weight(.semibold))
                Text("Send the first message to wake \(currentCompanion.name).")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(28)
        .companionGlass(radius: 28)
        .padding(.top, 56)
    }

    @ViewBuilder
    private var composer: some View {
        VStack(spacing: 8) {
            if let error, thread != nil {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Color.companionDanger)
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if thread?.canSend == false {
                Label("This conversation is read-only", systemImage: "eye")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.companionMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .companionGlass(radius: 20)
            } else {
                GlassEffectContainer(spacing: 12) {
                    HStack(alignment: .bottom, spacing: 10) {
                        TextField("Message \(currentCompanion.name)", text: $draft, axis: .vertical)
                            .lineLimit(1...5)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 13)
                            .companionGlass(radius: 23, interactive: true)
                            .accessibilityIdentifier("chat.composer")

                        Button(action: send) {
                            Group {
                                if sending {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "arrow.up")
                                }
                            }
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(visualTheme.accentForeground)
                            .frame(width: 46, height: 46)
                        }
                        .buttonStyle(.glassProminent)
                        .buttonBorderShape(.circle)
                        .tint(visualTheme.accent)
                        .disabled(sendDisabled)
                        .accessibilityLabel("Send message")
                        .accessibilityIdentifier("chat.send")
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var sendDisabled: Bool {
        sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || thread?.canSend == false
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: currentCompanion.icon)
    }

    private var statusLabel: String {
        if currentCompanion.runtime.replying { return "Replying" }
        switch currentCompanion.runtime.state {
        case .running: return "Online"
        case .provisioning: return "Starting"
        case .error: return "Needs attention"
        case .notCreated, .stopped, .stopping: return "Asleep"
        case .unknown: return "Unknown"
        }
    }

    private func reload(silently: Bool = false) async {
        reloadGeneration += 1
        let generation = reloadGeneration
        if !silently { loading = true }
        do {
            let next = try await sessionStore.thread(companionID: companion.id)
            let renderedMarkdown = await renderedMarkdown(for: next.entries)
            guard generation == reloadGeneration else { return }
            markdownByEventID = renderedMarkdown
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

        if let refreshed = try? await sessionStore.listCompanions().first(where: { $0.id == companion.id }) {
            guard generation == reloadGeneration else { return }
            currentCompanion = refreshed
        }
        if generation == reloadGeneration { loading = false }
    }

    private func renderedMarkdown(
        for entries: [TranscriptEntry]
    ) async -> [String: CachedMarkdownDocument] {
        let sources = entries.lazy
            .filter { $0.role == "assistant" }
            .map { MarkdownDocumentSource(eventID: $0.eventID, content: $0.content) }
        return await MarkdownDocumentRenderer.render(
            sources: Array(sources),
            reusing: markdownByEventID
        )
    }

    private var entries: [TranscriptEntry] {
        thread?.entries ?? []
    }

    private var pendingStartsNewDay: Bool {
        guard let last = entries.last, let date = transcriptDate(last.createdAt) else { return true }
        return !Calendar.autoupdatingCurrent.isDateInToday(date)
    }

    private func startsNewDay(_ entry: TranscriptEntry, after previous: TranscriptEntry?) -> Bool {
        guard let previous else { return true }
        guard let date = transcriptDate(entry.createdAt),
              let previousDate = transcriptDate(previous.createdAt) else { return true }
        return !Calendar.autoupdatingCurrent.isDate(date, inSameDayAs: previousDate)
    }

    private func dayLabel(for date: Date) -> String {
        let calendar = Calendar.autoupdatingCurrent
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if calendar.component(.year, from: date) == calendar.component(.year, from: .now) {
            return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year())
    }

    private func transcriptDate(_ value: String) -> Date? {
        parseCompanionTimestamp(value)
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

struct ChatMessageBubble: View {
    enum Kind: Equatable {
        case mine
        case assistant
        case member
    }

    let content: String
    let kind: Kind
    var authorName: String?
    var timestamp: String?
    var queued = false
    var companionName = "Companion"
    var icon: CompanionSummary.Icon?
    var accent = Color.companionAccent
    var markdown: MarkdownDocument?

    @ViewBuilder
    var body: some View {
        if kind == .assistant {
            row.accessibilityElement(children: .contain)
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    private var row: some View {
        HStack(alignment: kind == .assistant ? .top : .bottom, spacing: 9) {
            if kind == .mine { Spacer(minLength: 54) }

            if kind == .assistant {
                CompanionAvatar(name: companionName, icon: icon, size: 30, state: .still)
                    .accessibilityHidden(true)
            }

            bubble

            if kind != .mine { Spacer(minLength: kind == .assistant ? 12 : 36) }
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var bubble: some View {
        let contentView = VStack(alignment: .leading, spacing: 6) {
            if kind != .mine, let authorName {
                Text(authorName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
            }

            if kind == .assistant, let markdown {
                MarkdownMessageView(document: markdown, accent: accent)
            } else {
                Text(content)
                    .font(.body)
                    .foregroundStyle(Color.companionInk)
                    .textSelection(.enabled)
            }

            if queued || timestamp != nil {
                HStack(spacing: 6) {
                    if queued {
                        Text("Queued")
                    }
                    if let timestamp {
                        Text(timestamp)
                    }
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(Color.companionMuted)
            }
        }

        if kind == .mine {
            contentView
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(maxWidth: 340, alignment: .leading)
                .companionGlass(radius: 18, tint: accent.opacity(0.10))
        } else if kind == .assistant {
            contentView
                .padding(.vertical, 3)
                .frame(maxWidth: 680, alignment: .leading)
        } else {
            contentView
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(maxWidth: 340, alignment: .leading)
                .companionMaterial(radius: 18)
        }
    }
}

private struct MessageEntryView: View {
    let entry: TranscriptEntry
    let own: Bool
    let companion: CompanionSummary
    let accent: Color
    let markdown: MarkdownDocument?

    var body: some View {
        ChatMessageBubble(
            content: entry.content,
            kind: kind,
            authorName: own ? nil : entry.authorName ?? (entry.role == "user" ? "Workspace member" : companion.name),
            timestamp: timeLabel,
            queued: entry.queued,
            companionName: companion.name,
            icon: companion.icon,
            accent: accent,
            markdown: entry.role == "assistant" ? markdown : nil
        )
    }

    private var kind: ChatMessageBubble.Kind {
        if own { return .mine }
        return entry.role == "user" ? .member : .assistant
    }

    private var timeLabel: String? {
        guard let date = parseCompanionTimestamp(entry.createdAt) else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

private func parseCompanionTimestamp(_ value: String) -> Date? {
    (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
        ?? (try? Date.ISO8601FormatStyle().parse(value))
}

private struct PendingMessage: Identifiable, Equatable {
    let id: UUID
    let content: String
    var failed: Bool
}

private struct PendingMessageView: View {
    let message: PendingMessage
    let accent: Color
    let accentForeground: Color
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ChatMessageBubble(
                content: message.content,
                kind: .mine,
                timestamp: message.failed ? "Not delivered" : "Sending…",
                accent: accent
            )

            if message.failed {
                VStack(alignment: .trailing, spacing: 6) {
                    Text("Delivery could not be confirmed. Retrying reuses the same request.")
                        .font(.caption2)
                        .foregroundStyle(Color.companionDanger)
                    HStack(spacing: 8) {
                        Button("Dismiss", action: dismiss)
                            .buttonStyle(.glass)
                        Button("Retry", action: retry)
                            .buttonStyle(.glassProminent)
                            .tint(accent)
                            .foregroundStyle(accentForeground)
                    }
                    .controlSize(.small)
                }
                .padding(.trailing, 4)
            }
        }
    }
}
