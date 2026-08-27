import AppKit
import CompanionKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

@MainActor
@Observable
final class CompanionMacChatModel {
    let sessionStore: SessionStore
    private(set) var companion: CompanionSummary
    private(set) var thread: CompanionThread?
    private(set) var loading = true
    private(set) var sending = false
    private(set) var errorMessage: String?
    private(set) var actionError: String?
    private var projection = CompanionThreadProjection()

    init(companion: CompanionSummary, sessionStore: SessionStore) {
        self.companion = companion
        self.sessionStore = sessionStore
    }

    var canSend: Bool {
        companion.access.canEditCompanionSettings && thread?.canSend == true && thread?.readOnly == false
    }

    var isReplying: Bool {
        thread?.activeTurn?.replying == true || companion.runtime.replying
    }

    var statusLine: String {
        if isReplying { return "Replying" }
        switch companion.runtime.state {
        case .running: return "Online · Box running"
        case .provisioning: return "Starting · Box provisioning"
        case .stopping: return "Stopping · Box shutting down"
        case .error: return "Needs attention · Box error"
        case .notCreated, .stopped: return "Asleep · Box stopped"
        case .unknown: return "Unknown · Box status unavailable"
        }
    }

    func updateCompanion(_ companion: CompanionSummary) {
        guard self.companion.id == companion.id else { return }
        self.companion = companion
    }

    func start() async {
        await reload()
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(isReplying ? 3 : 12))
            guard !Task.isCancelled else { return }
            await reload(silently: true)
        }
    }

    func reload(silently: Bool = false) async {
        let generation = projection.beginRefresh()
        if !silently { loading = true }
        do {
            let next = try await sessionStore.thread(companionID: companion.id)
            guard projection.accepts(refresh: generation) else { return }
            _ = projection.accept(next, refresh: generation)
            thread = next
            errorMessage = nil
            if companion.unread {
                do {
                    let updated = try await sessionStore.updateCompanionMemberState(
                        companionID: companion.id,
                        patch: CompanionMemberStatePatch(unread: false)
                    )
                    updateCompanion(updated)
                } catch {
                    // Reading a thread remains useful when the private unread watermark update
                    // is temporarily unavailable; the next roster refresh reconciles it.
                }
            }
        } catch {
            if !silently || thread == nil {
                errorMessage = companionMacErrorMessage(error, fallback: "This conversation is temporarily unavailable.")
            }
        }
        loading = false
    }

    @discardableResult
    func send(content: String, attachments: [CompanionMessageAttachment]) async -> Bool {
        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !sending, !trimmedContent.isEmpty || !attachments.isEmpty else { return false }
        sending = true
        actionError = nil
        do {
            try await sessionStore.sendMessage(
                companionID: companion.id,
                content: trimmedContent,
                clientMessageID: UUID(),
                attachments: attachments
            )
            await reload()
            sending = false
            return true
        } catch {
            actionError = companionMacErrorMessage(error, fallback: "The message could not be sent. Try again.")
            sending = false
            return false
        }
    }

    func decide(requestID: String, action: CompanionDecisionAction) async {
        guard canSend else { return }
        actionError = nil
        do {
            let next = try await sessionStore.decideCompanionDecision(
                companionID: companion.id,
                requestID: requestID,
                action: action
            )
            projection.replaceAfterMutation(with: next)
            thread = next
        } catch {
            actionError = companionMacErrorMessage(error, fallback: "That decision could not be submitted.")
        }
    }

    func retryInterruptedTurn() async {
        guard canSend, let turn = thread?.interruptedTurn else { return }
        actionError = nil
        do {
            _ = try await sessionStore.retryCompanionTurn(
                companionID: companion.id,
                turnID: turn.id,
                retryID: UUID()
            )
            await reload()
        } catch {
            actionError = companionMacErrorMessage(error, fallback: "The interrupted turn could not be retried.")
        }
    }

    func cancelInterruptedTurn() async {
        guard canSend, let turn = thread?.interruptedTurn else { return }
        actionError = nil
        do {
            let next = try await sessionStore.cancelCompanionTurn(
                companionID: companion.id,
                turnID: turn.id
            )
            projection.replaceAfterMutation(with: next)
            thread = next
        } catch {
            actionError = companionMacErrorMessage(error, fallback: "The interrupted turn could not be cancelled.")
        }
    }
}

struct CompanionMacChatView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let onCompanionChanged: (CompanionSummary) -> Void
    let onSettings: (CompanionSummary) -> Void
    let onOpenDesktop: (CompanionSummary) -> Void
    @State private var model: CompanionMacChatModel
    @State private var draft = ""
    @State private var attachments: [CompanionMessageAttachment] = []
    @State private var attachmentError: String?
    @State private var expandedReasoning: Set<String> = []
    @FocusState private var composerFocused: Bool

    init(
        companion: CompanionSummary,
        sessionStore: SessionStore,
        onCompanionChanged: @escaping (CompanionSummary) -> Void,
        onSettings: @escaping (CompanionSummary) -> Void,
        onOpenDesktop: @escaping (CompanionSummary) -> Void
    ) {
        self.onCompanionChanged = onCompanionChanged
        self.onSettings = onSettings
        self.onOpenDesktop = onOpenDesktop
        _model = State(initialValue: CompanionMacChatModel(companion: companion, sessionStore: sessionStore))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            transcript
            Divider()
            composer
        }
        .background(Color.companionMacCanvas)
        .task(id: model.companion.id) {
            await model.start()
        }
        .onChange(of: model.companion) { _, companion in
            onCompanionChanged(companion)
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionMacFocusComposer)) { _ in
            composerFocused = true
        }
        .onChange(of: attachments) { _, items in
            if items.count > companionMessageAttachmentMaximumCount {
                attachmentError = "You can attach up to five files."
                attachments = Array(items.prefix(companionMessageAttachmentMaximumCount))
            }
        }
    }

    private var header: some View {
        HStack(spacing: CompanionMacMetrics.space * 2) {
            CompanionMacAvatar(
                name: model.companion.name,
                icon: model.companion.icon,
                size: 38,
                thinking: model.isReplying
            )
            VStack(alignment: .leading, spacing: CompanionMacMetrics.space / 2) {
                Text(model.companion.name)
                    .font(.headline)
                    .lineLimit(1)
                Text(model.statusLine)
                    .font(.caption)
                    .foregroundStyle(Color.companionMacMuted)
            }
            Spacer(minLength: CompanionMacMetrics.space * 2)
            CompanionMacStatusBadge(runtime: model.companion.runtime)
            if model.companion.access.canEditCompanionSettings {
                Button("Open Desktop", systemImage: "display") {
                    onOpenDesktop(model.companion)
                }
                .disabled(!CompanionMacDesktopEligibility.evaluate(
                    access: model.companion.access,
                    runtimeState: model.companion.runtime.state
                ).canOpen)
                .help(CompanionMacDesktopEligibility.evaluate(
                    access: model.companion.access,
                    runtimeState: model.companion.runtime.state
                ).explanation)
                .accessibilityIdentifier("chat.open-desktop")
            }
            Button("Settings", systemImage: "gearshape") {
                onSettings(model.companion)
            }
            .accessibilityIdentifier("chat.settings")
        }
        .padding(.horizontal, CompanionMacMetrics.space * 5)
        .padding(.vertical, CompanionMacMetrics.space * 3)
        .background(Color.companionMacSurface)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: CompanionMacMetrics.space * 4) {
                    if model.loading && model.thread == nil {
                        ProgressView("Loading conversation…")
                            .frame(maxWidth: .infinity, minHeight: 180)
                    } else if let error = model.errorMessage, model.thread == nil {
                        VStack(spacing: CompanionMacMetrics.space * 3) {
                            CompanionMacErrorNotice(message: error)
                            Button("Try again") { Task { await model.reload() } }
                        }
                        .frame(maxWidth: 520)
                        .frame(maxWidth: .infinity, minHeight: 180)
                    } else if let thread = model.thread {
                        if thread.entries.isEmpty && thread.interruptedTurn == nil && thread.queuedCount == 0 {
                            emptyConversation
                        }
                        ForEach(thread.entries) { entry in
                            CompanionMacTranscriptEntry(
                                entry: entry,
                                companion: model.companion,
                                viewerID: thread.viewerID,
                                canDecide: model.canSend,
                                decide: { action in
                                    await model.decide(requestID: entry.decision?.requestID ?? "", action: action)
                                },
                                reasoningExpanded: Binding(
                                    get: { expandedReasoning.contains(entry.id) },
                                    set: { expanded in
                                        if expanded { expandedReasoning.insert(entry.id) }
                                        else { expandedReasoning.remove(entry.id) }
                                    }
                                )
                            )
                            .id(entry.id)
                        }
                        if let interruptedTurn = thread.interruptedTurn {
                            CompanionMacInterruptedTurnView(
                                turn: interruptedTurn,
                                queuedCount: thread.queuedCount,
                                canAct: model.canSend,
                                actionError: model.actionError,
                                retry: { Task { await model.retryInterruptedTurn() } },
                                cancel: { Task { await model.cancelInterruptedTurn() } }
                            )
                            .id("interrupted-\(interruptedTurn.id)")
                        } else if thread.queuedCount > 0 {
                            CompanionMacQueuedStateView(count: thread.queuedCount)
                        }
                    }
                    if let actionError = model.actionError {
                        CompanionMacErrorNotice(message: actionError)
                            .frame(maxWidth: Self.contentMaxWidth)
                    }
                    Color.clear.frame(height: 1).id("chat-bottom")
                }
                .frame(maxWidth: Self.contentMaxWidth)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, CompanionMacMetrics.space * 6)
                .padding(.vertical, CompanionMacMetrics.space * 5)
            }
            .defaultScrollAnchor(.bottom)
            .scrollIndicators(.automatic)
            .onChange(of: model.thread?.entries.count) { _, _ in
                guard model.isReplying == false else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                    proxy.scrollTo("chat-bottom", anchor: .bottom)
                }
            }
        }
        .accessibilityIdentifier("chat.transcript")
    }

    private var emptyConversation: some View {
        VStack(spacing: CompanionMacMetrics.space * 3) {
            CompanionMacAvatar(name: model.companion.name, icon: model.companion.icon, size: 72)
            Text("Start a conversation")
                .font(.title3.weight(.semibold))
            Text("Send a message to wake the Companion when its Box is asleep.")
                .font(.callout)
                .foregroundStyle(Color.companionMacMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, CompanionMacMetrics.space * 12)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: CompanionMacMetrics.space * 2) {
            if model.thread?.readOnly == true || !model.canSend {
                Label("Viewer access is read-only. Sending a message will not contact this Box.", systemImage: "eye")
                    .font(.callout)
                    .foregroundStyle(Color.companionMacMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat.viewer-readonly")
            } else {
                if !attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: CompanionMacMetrics.space * 2) {
                            ForEach(attachments) { attachment in
                                HStack(spacing: CompanionMacMetrics.space) {
                                    Image(systemName: attachment.contentType.isImage ? "photo" : "doc")
                                    Text(attachment.filename).lineLimit(1)
                                    Button("Remove", systemImage: "xmark.circle.fill") {
                                        attachments.removeAll { $0.id == attachment.id }
                                    }
                                    .labelStyle(.iconOnly)
                                    .buttonStyle(.plain)
                                    .disabled(model.sending)
                                }
                                .font(.caption)
                                .padding(.horizontal, CompanionMacMetrics.space * 2)
                                .padding(.vertical, CompanionMacMetrics.space)
                                .background(Color.companionMacRaised, in: Capsule())
                                .overlay(Capsule().stroke(Color.companionMacDivider, lineWidth: 1))
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
                if let attachmentError {
                    Text(attachmentError)
                        .font(.caption)
                        .foregroundStyle(Color.companionMacDanger)
                }
                HStack(alignment: .bottom, spacing: CompanionMacMetrics.space * 2) {
                    Button("Attach files", systemImage: "paperclip") {
                        presentOpenPanel()
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.bordered)
                    .disabled(attachments.count >= companionMessageAttachmentMaximumCount || model.sending)
                    .accessibilityIdentifier("chat.attach")

                    TextField("Message \(model.companion.name)…", text: $draft, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($composerFocused)
                        .textFieldStyle(.plain)
                        .disabled(model.sending)
                        .padding(.horizontal, CompanionMacMetrics.space * 3)
                        .padding(.vertical, CompanionMacMetrics.space * 2)
                        .background(Color.companionMacRaised, in: RoundedRectangle(cornerRadius: 7))
                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.companionMacDivider, lineWidth: 1))
                        .accessibilityIdentifier("chat.composer")

                    Button {
                        let content = draft
                        let files = attachments
                        Task {
                            if await model.send(content: content, attachments: files) {
                                draft = ""
                                attachments = []
                            }
                        }
                    } label: {
                        if model.sending {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(model.sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty)
                    .accessibilityLabel(model.sending ? "Sending message" : "Send message")
                    .accessibilityIdentifier("chat.send")
                }
            }
        }
        .frame(maxWidth: Self.contentMaxWidth)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, CompanionMacMetrics.space * 6)
        .padding(.vertical, CompanionMacMetrics.space * 3)
        .background(Color.companionMacSurface)
    }

    private static let contentMaxWidth: CGFloat = CompanionMacMetrics.transcriptMaxWidth
    private static let allowedAttachmentTypes: [UTType] = [
        .png, .jpeg, .webP, .gif, .pdf, .commaSeparatedText, .plainText, .json,
        UTType(filenameExtension: "md") ?? .plainText,
    ]

    private func presentOpenPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = Self.allowedAttachmentTypes
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canCreateDirectories = false
        panel.begin { response in
            guard response == .OK else { return }
            let urls = panel.urls
            Task { @MainActor in
                importFiles(urls)
            }
        }
    }

    private func importFiles(_ urls: [URL]) {
        attachmentError = nil
        for url in urls.prefix(companionMessageAttachmentMaximumCount - attachments.count) {
            do {
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                let attachment = try CompanionMessageAttachment(
                    data: data,
                    filename: url.lastPathComponent,
                    declaredContentType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                )
                attachments.append(attachment)
            } catch let attachmentError as CompanionMessageAttachmentError {
                self.attachmentError = attachmentError.errorDescription
            } catch {
                self.attachmentError = "The selected file could not be read."
            }
        }
    }
}

private struct CompanionMacTranscriptEntry: View {
    let entry: TranscriptEntry
    let companion: CompanionSummary
    let viewerID: String
    let canDecide: Bool
    let decide: (CompanionDecisionAction) async -> Void
    @Binding var reasoningExpanded: Bool

    var body: some View {
        HStack(alignment: .top, spacing: CompanionMacMetrics.space * 2) {
            if isUser { Spacer(minLength: 80) }
            VStack(alignment: .leading, spacing: CompanionMacMetrics.space * 2) {
                HStack(spacing: CompanionMacMetrics.space * 1.5) {
                    if !isUser {
                        CompanionMacAvatar(name: companion.name, icon: companion.icon, size: 26, thinking: false)
                    }
                    Text(isUser ? (entry.authorName ?? "You") : companion.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.companionMacMuted)
                    Text(entry.createdAt.macShortDate)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Color.companionMacMuted)
                }
                if !entry.content.isEmpty {
                    CompanionMacMarkdownText(markdown: entry.content)
                }
                if entry.queued {
                    Label("Queued", systemImage: "clock")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.companionMacMuted)
                        .accessibilityLabel("Message queued")
                }
                if let decision = entry.decision {
                    CompanionMacDecisionCard(
                        decision: decision,
                        canAct: canDecide,
                        onDecide: { action in
                            await decide(action)
                        }
                    )
                }
                if let reasoning = entry.reasoning, !reasoning.isEmpty {
                    DisclosureGroup("Reasoning", isExpanded: $reasoningExpanded) {
                        Text(reasoning)
                            .font(.callout.monospaced())
                            .foregroundStyle(Color.companionMacMuted)
                            .textSelection(.enabled)
                            .padding(.top, CompanionMacMetrics.space)
                    }
                    .font(.caption)
                    .tint(Color.companionMacAccent)
                }
                if let tool = entry.tool {
                    CompanionMacToolCard(tool: tool)
                }
                if !entry.attachments.isEmpty {
                    VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                        ForEach(entry.attachments) { attachment in
                            CompanionMacAttachmentView(
                                attachment: attachment,
                                companionID: companion.id
                            )
                        }
                    }
                }
            }
            .padding(CompanionMacMetrics.space * 3)
            .background(isUser ? Color.companionMacAccent.opacity(0.14) : Color.companionMacSurface)
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(isUser ? Color.companionMacAccent.opacity(0.38) : Color.companionMacDivider, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            if !isUser { Spacer(minLength: 80) }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .accessibilityIdentifier("chat.entry.\(entry.eventID)")
    }

    private var isUser: Bool {
        entry.role == "user" && entry.authorID == viewerID
    }
}

private struct CompanionMacMarkdownText: View {
    let markdown: String

    var body: some View {
        Text(attributedMarkdown)
            .font(.body)
            .foregroundStyle(Color.companionMacInk)
            .textSelection(.enabled)
            .environment(
                \.openURL,
                OpenURLAction { url in
                    CompanionLinkPolicy.isAllowed(url) ? .systemAction : .discarded
                }
            )
    }

    private var attributedMarkdown: AttributedString {
        do {
            return try AttributedString(
                markdown: markdown,
                options: .init(
                    interpretedSyntax: .full,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            )
        } catch {
            return AttributedString(markdown)
        }
    }
}

private struct CompanionMacToolCard: View {
    let tool: CompanionToolRun

    var body: some View {
        HStack(alignment: .top, spacing: CompanionMacMetrics.space * 2) {
            Image(systemName: symbol)
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                HStack {
                    Text(tool.title)
                        .font(.callout.weight(.medium))
                    Spacer()
                    Text(tool.status.rawValue.capitalized)
                        .font(.caption)
                        .foregroundStyle(color)
                }
                if let detail = tool.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Color.companionMacMuted)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(CompanionMacMetrics.space * 2)
        .background(Color.companionMacRaised, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.companionMacDivider, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Tool \(tool.title), \(tool.status.rawValue)")
    }

    private var symbol: String {
        switch tool.kind {
        case .shell: return "terminal"
        case .file: return "doc.text"
        case .browse: return "safari"
        case .computer: return "display"
        case .subagent: return "person.2"
        case .tool: return "wrench.and.screwdriver"
        }
    }

    private var color: Color {
        switch tool.status {
        case .ok: return .companionMacSuccess
        case .error, .timeout: return .companionMacDanger
        case .running: return .companionMacAccent
        }
    }
}

private struct CompanionMacDecisionCard: View {
    let decision: CompanionDecision
    let canAct: Bool
    let onDecide: (CompanionDecisionAction) async -> Void
    @State private var answer = ""
    @State private var submitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: CompanionMacMetrics.space * 2) {
            HStack(spacing: CompanionMacMetrics.space * 1.5) {
                Image(systemName: symbol)
                    .foregroundStyle(statusColor)
                Text(decision.title)
                    .font(.callout.weight(.semibold))
                Spacer()
                Text(statusLabel)
                    .font(.caption)
                    .foregroundStyle(statusColor)
            }
            if let detail = decision.detail, !detail.isEmpty {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(Color.companionMacMuted)
                    .lineLimit(8)
                    .textSelection(.enabled)
            }
            if let proposal = proposalSummary {
                Text(proposal)
                    .font(.caption.monospaced())
                    .foregroundStyle(Color.companionMacMuted)
                    .lineLimit(6)
            }
            if decision.status == .pending {
                if decision.kind == .question {
                    TextField("Answer", text: $answer, axis: .vertical)
                        .lineLimit(2...5)
                        .textFieldStyle(.roundedBorder)
                }
                HStack {
                    if decision.kind == .question {
                        Button("Answer") {
                            submit(.answer(answer.trimmingCharacters(in: .whitespacesAndNewlines)))
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canAct || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || submitting)
                    } else {
                        Button("Allow") { submit(.allow) }
                            .buttonStyle(.borderedProminent)
                            .disabled(!canAct || submitting)
                    }
                    Button("Deny", role: .destructive) { submit(.deny) }
                        .disabled(!canAct || submitting)
                    if !canAct {
                        Label("Read-only", systemImage: "eye")
                            .font(.caption)
                            .foregroundStyle(Color.companionMacMuted)
                    }
                }
            } else if let decidedByName = decision.decidedByName {
                Text("\(statusLabel) by \(decidedByName)")
                    .font(.caption)
                    .foregroundStyle(Color.companionMacMuted)
            }
        }
        .padding(CompanionMacMetrics.space * 3)
        .frame(maxWidth: 640, alignment: .leading)
        .background(Color.companionMacAccent.opacity(0.09), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.companionMacAccent.opacity(0.32), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.decision.\(decision.requestID)")
    }

    private var symbol: String {
        switch decision.kind {
        case .question: return "questionmark.circle"
        case .shell: return "terminal"
        case .file: return "doc.text"
        case .config, .routine, .trigger: return "checkmark.shield"
        case .unknown: return "questionmark"
        }
    }

    private var statusLabel: String {
        switch decision.status {
        case .pending: return "Waiting"
        case .allowed: return "Allowed"
        case .denied: return "Denied"
        case .answered: return "Answered"
        case .expired: return "Expired"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }

    private var statusColor: Color {
        switch decision.status {
        case .pending: return .companionMacAccent
        case .allowed, .answered: return .companionMacSuccess
        case .denied, .expired, .cancelled: return .companionMacDanger
        case .unknown: return .companionMacUnknown
        }
    }

    private var proposalSummary: String? {
        switch decision.proposal {
        case .config(let proposal):
            var pieces: [String] = []
            if !proposal.addSkillIDs.isEmpty { pieces.append("Add skills: \(proposal.addSkillIDs.joined(separator: ", "))") }
            if !proposal.removeSkillIDs.isEmpty { pieces.append("Remove skills: \(proposal.removeSkillIDs.joined(separator: ", "))") }
            if let modelID = proposal.modelID { pieces.append("Model: \(modelID)") }
            if proposal.includesPersona { pieces.append("Update persona") }
            if let plugin = proposal.connectPlugin { pieces.append("Connect plugin: \(plugin.serverName)") }
            return pieces.isEmpty ? "Configuration change proposed" : pieces.joined(separator: " · ")
        case .routine(let proposal):
            return "Routine: \(proposal.name) · \(proposal.cron) · \(proposal.timezone)"
        case .trigger(let proposal):
            return "Trigger: \(proposal.name) · \(proposal.provider)"
        case nil:
            return nil
        }
    }

    private func submit(_ action: CompanionDecisionAction) {
        guard canAct, !submitting else { return }
        submitting = true
        Task {
            await onDecide(action)
            submitting = false
        }
    }
}

private struct CompanionMacAttachmentView: View {
    @Environment(SessionStore.self) private var sessionStore
    let attachment: CompanionAttachment
    let companionID: String
    @State private var image: NSImage?

    var body: some View {
        HStack(spacing: CompanionMacMetrics.space * 2) {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220, maxHeight: 140)
            } else {
                Image(systemName: attachment.contentType.isImage ? "photo" : "doc.text")
                    .foregroundStyle(Color.companionMacAccent)
            }
            Text(attachment.filename)
                .font(.caption)
                .lineLimit(1)
            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.byteSize), countStyle: .file))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(Color.companionMacMuted)
        }
        .task {
            guard attachment.kind == .piOutput, attachment.contentType.isImage else { return }
            guard let data = try? await sessionStore.attachmentData(
                companionID: companionID,
                attachmentID: attachment.id
            ) else { return }
            image = NSImage(data: data)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Attachment \(attachment.filename)")
    }
}

private struct CompanionMacInterruptedTurnView: View {
    let turn: CompanionTurn
    let queuedCount: Int
    let canAct: Bool
    let actionError: String?
    let retry: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: CompanionMacMetrics.space * 2) {
            Label("Turn interrupted", systemImage: "pause.circle.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(Color.companionMacWarning)
            Text("The runtime stopped waiting for this turn. Earlier external effects may have succeeded. Retry only if that is safe.")
                .font(.callout)
                .foregroundStyle(Color.companionMacMuted)
            HStack {
                Button("Retry", action: retry)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canAct)
                Button("Cancel", role: .destructive, action: cancel)
                    .disabled(!canAct)
                if queuedCount > 0 {
                    Text("\(queuedCount) later message\(queuedCount == 1 ? "" : "s") queued")
                        .font(.caption)
                        .foregroundStyle(Color.companionMacMuted)
                }
            }
            if let actionError {
                Text(actionError)
                    .font(.caption)
                    .foregroundStyle(Color.companionMacDanger)
            }
        }
        .padding(CompanionMacMetrics.space * 3)
        .frame(maxWidth: 620, alignment: .leading)
        .background(Color.companionMacWarning.opacity(0.11), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.companionMacWarning.opacity(0.36), lineWidth: 1))
        .accessibilityIdentifier("chat.interrupted-turn")
    }
}

private struct CompanionMacQueuedStateView: View {
    let count: Int

    var body: some View {
        Label(
            "\(count) message\(count == 1 ? "" : "s") queued. They will run in order.",
            systemImage: "clock"
        )
        .font(.callout)
        .foregroundStyle(Color.companionMacMuted)
        .padding(CompanionMacMetrics.space * 2)
        .accessibilityIdentifier("chat.queued-state")
    }
}

private extension String {
    var macShortDate: String {
        guard let date = ISO8601DateFormatter().date(from: self) else { return "" }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
