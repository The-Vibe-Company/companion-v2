import CompanionKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct ChatServices {
    let thread: (String) async throws -> CompanionThread
    let listCompanions: () async throws -> [CompanionSummary]
    let decide: (String, String, CompanionDecisionAction) async throws -> CompanionThread
    let retryTurn: (String, String, UUID) async throws -> CompanionOperationSummary
    let cancelTurn: (String, String) async throws -> CompanionThread
    let listSkills: () async throws -> [CompanionSkillReference]
    let listPlugins: () async throws -> [CompanionPluginAccount]
    let listProviders: () async throws -> CompanionProvidersResponse
}

struct ChatView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let companion: CompanionSummary
    let onResources: () -> Void
    let onSettings: () -> Void
    let onPlugins: () -> Void
    private let services: ChatServices?
    @State private var currentCompanion: CompanionSummary
    @State private var threadProjection = CompanionThreadProjection()
    @State private var draft = ""
    @State private var draftAttachments: [CompanionMessageAttachment] = []
    @State private var attachmentError: String?
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showDocumentPicker = false
    @State private var selectingAttachments = false
    @State private var loading = true
    @State private var sending = false
    @State private var error: String?
    @State private var pendingMessages: [PendingMessage] = []
    @State private var markdownByEventID: [String: CachedMarkdownDocument] = [:]
    @State private var threadMutationGate = CompanionThreadMutationGate()
    @State private var decisionCatalog = CompanionDecisionCatalog.empty
    @State private var decisionCatalogLoaded = false
    @FocusState private var composerFocused: Bool

    init(
        companion: CompanionSummary,
        onResources: @escaping () -> Void = {},
        onPlugins: @escaping () -> Void = {},
        services: ChatServices? = nil,
        onSettings: @escaping () -> Void
    ) {
        self.companion = companion
        self.onPlugins = onPlugins
        self.services = services
        self.onResources = onResources
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
                        } else if entries.isEmpty && pendingMessages.isEmpty
                                    && thread?.interruptedTurn == nil {
                            emptyState
                        } else {
                            ForEach(Array(renderedEntries.enumerated()), id: \.element.id) { index, entry in
                                if startsNewDay(
                                    entry,
                                    after: index > 0 ? renderedEntries[index - 1] : nil
                                ) {
                                    dayMarker(for: transcriptDate(entry.createdAt) ?? .now)
                                }
                                Group {
                                    if let decision = entry.decision {
                                        CompanionDecisionCard(
                                            decision: decision,
                                            companionName: currentCompanion.name,
                                            canAct: thread?.canSend == true,
                                            catalog: decisionCatalog,
                                            accent: visualTheme.accent,
                                            accentForeground: visualTheme.accentForeground,
                                            onDecide: { action in
                                                try await decide(
                                                    requestID: decision.requestID,
                                                    action: action
                                                )
                                            },
                                            onOpenPlugins: onPlugins
                                        )
                                    } else {
                                        MessageEntryView(
                                            entry: entry,
                                            own: entry.role == "user" && entry.authorID == thread?.viewerID,
                                            companion: currentCompanion,
                                            accent: visualTheme.accent,
                                            markdown: markdownByEventID[entry.eventID]?.document
                                        )
                                    }
                                }
                                .id(entry.id)
                            }

                            if let interruptedTurn = thread?.interruptedTurn {
                                CompanionInterruptedTurnNotice(
                                    turn: interruptedTurn,
                                    queuedCount: thread?.queuedCount ?? 0,
                                    canAct: thread?.canSend == true,
                                    latestOperation: currentCompanion.runtime.latestOperation,
                                    accent: visualTheme.accent,
                                    accentForeground: visualTheme.accentForeground,
                                    onRetry: retryInterruptedTurn,
                                    onCancel: cancelTurn
                                )
                                .id("interrupted-\(interruptedTurn.id)")
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
                .safeAreaInset(edge: .bottom) { bottomControls }
                .onChange(of: scrollContentCount) {
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
        .task(id: decisionCatalogTaskID) {
            guard decisionCatalogTaskID != nil else { return }
            await loadDecisionCatalog()
        }
        .onChange(of: companion) { currentCompanion = companion }
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
            Button(action: onResources) {
                Image(systemName: "link")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Connected resources for \(currentCompanion.name)")
            .accessibilityIdentifier("chat.resources")
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
    private var bottomControls: some View {
        VStack(spacing: 8) {
            if !queuedEntries.isEmpty {
                CompanionQueuedMessagesView(
                    entries: queuedEntries,
                    canManage: thread?.canSend == true,
                    accent: visualTheme.accent,
                    onRemove: cancelTurn
                )
                .padding(.horizontal, 12)
            }

            composer
        }
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
                if !draftAttachments.isEmpty {
                    ComposerAttachmentStrip(
                        attachments: draftAttachments,
                        onRemove: removeAttachment
                    )
                    .padding(.horizontal, 2)
                }

                if let attachmentError {
                    Text(attachmentError)
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                        .accessibilityLabel("Attachment error: \(attachmentError)")
                }

                GlassEffectContainer(spacing: 12) {
                    HStack(alignment: .bottom, spacing: 10) {
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
                            .frame(width: 46, height: 46)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
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

                        TextField("Message \(currentCompanion.name)", text: $draft, axis: .vertical)
                            .lineLimit(1...5)
                            .focused($composerFocused)
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

                if !draftAttachments.isEmpty,
                   draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Add a message to send \(draftAttachments.count == 1 ? "this file" : "these files").")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var sendDisabled: Bool {
        sending
            || selectingAttachments
            || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || thread?.canSend == false
    }

    private var attachDisabled: Bool {
        sending || selectingAttachments || remainingAttachmentCapacity == 0 || thread?.canSend == false
    }

    private var remainingAttachmentCapacity: Int {
        max(0, companionMessageAttachmentMaximumCount - draftAttachments.count)
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
        let generation = threadProjection.beginRefresh()
        if !silently { loading = true }
        do {
            let next: CompanionThread
            if let services {
                next = try await services.thread(companion.id)
            } else {
                next = try await sessionStore.thread(companionID: companion.id)
            }
            let renderedMarkdown = await renderedMarkdown(for: next.entries)
            guard threadProjection.accepts(refresh: generation) else { return }
            markdownByEventID = renderedMarkdown
            threadProjection.accept(next, refresh: generation)
            let persistedEventIDs = Set(next.entries.map(\.eventID))
            pendingMessages.removeAll { pending in
                persistedEventIDs.contains("msg:\(pending.id.uuidString.lowercased())")
            }
            error = nil
        } catch {
            guard threadProjection.accepts(refresh: generation) else { return }
            self.error = "The conversation could not be refreshed."
        }

        let refreshed: CompanionSummary?
        if let services {
            refreshed = try? await services.listCompanions().first(where: { $0.id == companion.id })
        } else {
            refreshed = try? await sessionStore.listCompanions().first(where: { $0.id == companion.id })
        }
        if let refreshed {
            guard threadProjection.accepts(refresh: generation) else { return }
            currentCompanion = refreshed
        }
        if threadProjection.accepts(refresh: generation) { loading = false }
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

    private var renderedEntries: [TranscriptEntry] {
        entries.filter { !$0.queued }
    }

    private var queuedEntries: [TranscriptEntry] {
        entries.filter(\.queued)
    }

    private var thread: CompanionThread? {
        threadProjection.thread
    }

    private var decisionCatalogTaskID: String? {
        entries.contains { entry in
            guard let decision = entry.decision else { return false }
            return decision.kind == .config
        } ? companion.id : nil
    }

    private var pendingStartsNewDay: Bool {
        guard let last = renderedEntries.last,
              let date = transcriptDate(last.createdAt) else { return true }
        return !Calendar.autoupdatingCurrent.isDateInToday(date)
    }

    private var scrollContentCount: Int {
        renderedEntries.count + pendingMessages.count + (thread?.interruptedTurn == nil ? 0 : 1)
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
        let message = PendingMessage(
            id: UUID(),
            content: content,
            attachments: draftAttachments,
            failed: false,
            uploadProgress: draftAttachments.isEmpty ? nil : 0
        )
        pendingMessages.append(message)
        draft = ""
        draftAttachments = []
        attachmentError = nil
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
        if !message.attachments.isEmpty { pendingMessages[index].uploadProgress = 0 }
        error = nil
        let uploadProgress: (@Sendable (Double) -> Void)?
        if message.attachments.isEmpty {
            uploadProgress = nil
        } else {
            uploadProgress = { progress in
                Task { @MainActor in
                    guard let current = pendingMessages.firstIndex(where: { $0.id == id }) else {
                        return
                    }
                    pendingMessages[current].uploadProgress = progress
                }
            }
        }
        do {
            try await sessionStore.sendMessage(
                companionID: companion.id,
                content: message.content,
                clientMessageID: message.id,
                attachments: message.attachments,
                uploadProgress: uploadProgress
            )
            pendingMessages.removeAll { $0.id == id }
            await reload(silently: true)
        } catch {
            if let current = pendingMessages.firstIndex(where: { $0.id == id }) {
                pendingMessages[current].failed = true
            }
        }
    }

    private func decide(
        requestID: String,
        action: CompanionDecisionAction
    ) async throws {
        let mutationID = "decision:\(requestID)"
        guard await threadMutationGate.acquire(mutationID: mutationID) else { return }
        threadProjection.invalidateRefreshes()

        do {
            let next: CompanionThread
            if let services {
                next = try await services.decide(companion.id, requestID, action)
            } else {
                next = try await sessionStore.decideCompanionDecision(
                    companionID: companion.id,
                    requestID: requestID,
                    action: action
                )
            }

            threadProjection.replaceAfterMutation(with: next)
            let renderedMarkdown = await renderedMarkdown(for: next.entries)
            markdownByEventID = renderedMarkdown
            await threadMutationGate.release(mutationID: mutationID)
        } catch {
            threadProjection.invalidateRefreshes()
            await reload(silently: true)
            await threadMutationGate.release(mutationID: mutationID)
            throw error
        }
    }

    private func retryInterruptedTurn(
        turnID: String,
        retryID: UUID
    ) async throws -> CompanionOperationSummary {
        threadProjection.invalidateRefreshes()
        let operation: CompanionOperationSummary
        if let services {
            operation = try await services.retryTurn(companion.id, turnID, retryID)
        } else {
            operation = try await sessionStore.retryCompanionTurn(
                companionID: companion.id,
                turnID: turnID,
                retryID: retryID
            )
        }
        await reload(silently: true)
        return operation
    }

    private func cancelTurn(turnID: String) async throws {
        let mutationID = "cancel:\(turnID)"
        guard await threadMutationGate.acquire(mutationID: mutationID) else { return }
        threadProjection.invalidateRefreshes()
        do {
            let next: CompanionThread
            if let services {
                next = try await services.cancelTurn(companion.id, turnID)
            } else {
                next = try await sessionStore.cancelCompanionTurn(
                    companionID: companion.id,
                    turnID: turnID
                )
            }
            threadProjection.replaceAfterMutation(with: next)
            markdownByEventID = await renderedMarkdown(for: next.entries)
            await refreshCompanionProjection()
            await threadMutationGate.release(mutationID: mutationID)
        } catch {
            await reload(silently: true)
            await threadMutationGate.release(mutationID: mutationID)
            throw error
        }
    }

    private func refreshCompanionProjection() async {
        let refreshed: CompanionSummary?
        if let services {
            refreshed = try? await services.listCompanions().first(where: { $0.id == companion.id })
        } else {
            refreshed = try? await sessionStore.listCompanions().first(where: { $0.id == companion.id })
        }
        if let refreshed { currentCompanion = refreshed }
    }

    private func loadDecisionCatalog() async {
        guard !decisionCatalogLoaded else { return }
        decisionCatalogLoaded = true

        async let skillsResult = loadDecisionSkills()
        async let pluginsResult = loadDecisionPlugins()
        async let providersResult = loadDecisionProviders()
        let (skills, plugins, providers) = await (skillsResult, pluginsResult, providersResult)
        guard !Task.isCancelled else { return }

        decisionCatalog = CompanionDecisionCatalog(
            skills: Dictionary(uniqueKeysWithValues: skills.map { ($0.id, $0.slug) }),
            plugins: Dictionary(uniqueKeysWithValues: plugins.map {
                ($0.id, "\($0.provider) · \($0.label)")
            }),
            models: providers.reduce(into: [String: String]()) { result, provider in
                for model in provider.models { result[model.id] = model.name }
            }
        )
    }

    private func loadDecisionSkills() async -> [CompanionSkillReference] {
        if let services { return (try? await services.listSkills()) ?? [] }
        return (try? await sessionStore.listAccessibleCompanionSkills()) ?? []
    }

    private func loadDecisionPlugins() async -> [CompanionPluginAccount] {
        if let services { return (try? await services.listPlugins()) ?? [] }
        return (try? await sessionStore.listCompanionPlugins()) ?? []
    }

    private func loadDecisionProviders() async -> [CompanionProviderDefinition] {
        let response: CompanionProvidersResponse?
        if let services {
            response = try? await services.listProviders()
        } else {
            response = try? await sessionStore.listCompanionProviders()
        }
        return response?.catalog ?? []
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
    var companionID: String?
    var icon: CompanionSummary.Icon?
    var accent = Color.companionAccent
    var markdown: MarkdownDocument?
    var attachments: [CompanionAttachment] = []
    var localAttachments: [CompanionMessageAttachment] = []

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

            if !localAttachments.isEmpty {
                LocalMessageAttachmentList(attachments: localAttachments)
            }

            if let companionID, !attachments.isEmpty {
                TranscriptAttachmentList(
                    companionID: companionID,
                    attachments: attachments
                )
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

    @ViewBuilder
    var body: some View {
        if entry.role == "tool", let tool = entry.tool {
            CompanionToolRunCard(tool: tool)
        } else {
            ChatMessageBubble(
                content: entry.content,
                kind: kind,
                authorName: own ? nil : entry.authorName ?? (entry.role == "user" ? "Workspace member" : companion.name),
                timestamp: timeLabel,
                queued: entry.queued,
                companionName: companion.name,
                companionID: companion.id,
                icon: companion.icon,
                accent: accent,
                markdown: entry.role == "assistant" ? markdown : nil,
                attachments: entry.attachments
            )
        }
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
    let attachments: [CompanionMessageAttachment]
    var failed: Bool
    var uploadProgress: Double?
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
                timestamp: statusLabel,
                accent: accent,
                localAttachments: message.attachments
            )

            if let progress = message.uploadProgress, !message.failed {
                ProgressView(value: progress)
                    .tint(accent)
                    .frame(maxWidth: 220)
                    .accessibilityLabel("Uploading attachments")
                    .accessibilityValue(progress.formatted(.percent.precision(.fractionLength(0))))
            }

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

    private var statusLabel: String {
        if message.failed { return "Not delivered" }
        guard let progress = message.uploadProgress else { return "Sending…" }
        if progress >= 1 { return "Finishing upload…" }
        return "Uploading \(progress.formatted(.percent.precision(.fractionLength(0))))"
    }
}

private struct AttachmentImportResult: Sendable {
    let attachments: [CompanionMessageAttachment]
    let firstError: String?
}
