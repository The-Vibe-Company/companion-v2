import Foundation
import CompanionKit
import SwiftUI
import UIKit

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

private struct AssistantTailReveal: Equatable, Sendable {
    let id: UUID
    let eventID: String
    let baseMarkdown: MarkdownDocument?
    var visibleDelta: String
    var followsTail: Bool
}

private struct AssistantTailChange: Equatable, Sendable {
    let eventID: String
    let previousContent: String
    let nextContent: String
}

private struct ScrollDeliveryRevision: Equatable {
    let contentRevision: Int
    let initialBottomReadyRevision: Int?
}

private struct BottomDestinationLayoutSignal: Equatable {
    let contentRevision: Int
    let minY: CGFloat
}

/// Fences overlapping refresh tasks without making each poll a SwiftUI-observed state mutation.
private final class ChatRefreshGate {
    private var revision = 0

    func begin() -> Int {
        revision += 1
        return revision
    }

    func invalidate() {
        revision += 1
    }

    func accepts(_ refresh: Int) -> Bool {
        refresh == revision
    }
}

private struct TranscriptKeyboardDismissGesture: UIGestureRecognizerRepresentable {
    let onTap: () -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UITapGestureRecognizer {
        let recognizer = UITapGestureRecognizer()
        recognizer.cancelsTouchesInView = false
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func handleUIGestureRecognizerAction(
        _ recognizer: UITapGestureRecognizer,
        context: Context
    ) {
        onTap()
    }
}

struct ChatView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let companion: CompanionSummary
    let onSettings: () -> Void
    let onPlugins: () -> Void
    let onReadingPositionChange: (CompanionChatReadingPosition) -> Void
    private let readingPosition: CompanionChatReadingPosition?
    private let services: ChatServices?
    @State private var currentCompanion: CompanionSummary
    @State private var threadProjection = CompanionThreadProjection()
    @State private var refreshGate = ChatRefreshGate()
    @State private var loading = true
    @State private var sending = false
    @State private var error: String?
    @State private var pendingMessages: [PendingMessage] = []
    @State private var markdownByEventID: [String: CachedMarkdownDocument] = [:]
    @State private var expandedReasoningEventIDs: Set<String> = []
    @State private var threadMutationGate = CompanionThreadMutationGate()
    @State private var decisionCatalog = CompanionDecisionCatalog.empty
    @State private var decisionCatalogLoaded = false
    @State private var transcriptWindow = CompanionTranscriptWindow()
    @State private var scrollCoordinator = CompanionScrollCoordinator()
    @State private var unseenTracker = CompanionTranscriptUnseenTracker()
    @State private var unseenCount = 0
    @State private var loadingEarlier = false
    @State private var scrollContentRevision = 0
    @State private var initialBottomReadyRevision: Int?
    @State private var transcriptScrollPosition = ScrollPosition(idType: String.self)
    @State private var pendingReadingPosition: CompanionChatReadingPosition?
    @State private var lastReportedReadingPosition: CompanionChatReadingPosition?
    @State private var visibleEntryIDs: [String] = []
    @State private var isRestoringReadingPosition = false
    @State private var restorationTargetEventID: String?
    @State private var restorationScrollPerformed = false
    @State private var assistantTailReveal: AssistantTailReveal?
    @State private var assistantTailRevealTask: Task<Void, Never>?
    @State private var selectedToolDetail: ToolRunDetailRoute?

    private let bottomProximityThreshold: CGFloat = 80

    init(
        companion: CompanionSummary,
        readingPosition: CompanionChatReadingPosition? = nil,
        onPlugins: @escaping () -> Void = {},
        services: ChatServices? = nil,
        onReadingPositionChange: @escaping (CompanionChatReadingPosition) -> Void = { _ in },
        onSettings: @escaping () -> Void
    ) {
        self.companion = companion
        self.readingPosition = readingPosition
        self.onPlugins = onPlugins
        self.services = services
        self.onReadingPositionChange = onReadingPositionChange
        self.onSettings = onSettings
        _currentCompanion = State(initialValue: companion)
        _pendingReadingPosition = State(initialValue: readingPosition)
        _scrollCoordinator = State(
            initialValue: CompanionScrollCoordinator(
                followState: readingPosition?.isFollowingTail == false
                    ? .userReading
                    : .followingTail
            )
        )
    }

    var body: some View {
        let visibleEntries = entries
        let renderedEntries = visibleEntries
        let queuedEntries = queuedEntries(in: thread)
        let renderedScrollRevision = scrollContentRevision
        let renderedScrollDeliveryRevision = ScrollDeliveryRevision(
            contentRevision: renderedScrollRevision,
            initialBottomReadyRevision: initialBottomReadyRevision
        )
        CompanionBackdrop {
            VStack(spacing: 0) {
                ScrollView {
                        VStack(spacing: 16) {
                            LazyVStack(spacing: 16) {
                                if loading && thread == nil {
                                    ProgressView("Loading conversation…")
                                        .padding(.top, 80)
                                } else if let error, thread == nil {
                                    unavailableState(error)
                                } else if visibleEntries.isEmpty && pendingMessages.isEmpty
                                            && thread?.interruptedTurn == nil {
                                    emptyState
                                } else {
                                    if transcriptWindow.hasEarlierEntries {
                                        loadEarlierButton
                                    }

                                    ForEach(Array(renderedEntries.enumerated()), id: \.element.eventID) { index, entry in
                                        if startsNewDay(
                                            entry,
                                            after: index > 0 ? renderedEntries[index - 1] : nil
                                        ) {
                                            dayMarker(for: transcriptDate(entry.createdAt) ?? .now)
                                        }
                                        TranscriptRowView(
                                            input: transcriptRowInput(for: entry),
                                            onDecide: { action in
                                                guard let decision = entry.decision else { return }
                                                try await decide(
                                                    requestID: decision.requestID,
                                                    action: action
                                                )
                                            },
                                            onOpenPlugins: onPlugins,
                                            onReasoningExpansionChange: { isExpanded in
                                                setReasoningExpanded(isExpanded, for: entry.eventID)
                                            },
                                            onOpenToolDetails: { selectedToolDetail = $0 }
                                        )
                                        .equatable()
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
                            }
                            .scrollTargetLayout()

                            // Keep a layout-readiness probe outside the lazy stack so initial
                            // delivery waits until the complete transcript content is placed.
                            Color.clear
                                .frame(height: 1)
                                .id("bottom")
                                .onGeometryChange(for: BottomDestinationLayoutSignal.self) { geometry in
                                    BottomDestinationLayoutSignal(
                                        contentRevision: renderedScrollRevision,
                                        minY: geometry.frame(
                                            in: .scrollView(axis: .vertical)
                                        ).minY
                                    )
                                } action: { _, signal in
                                    // An initial request is not safe to consume merely because a
                                    // render task yielded: the lazy transcript may not have placed
                                    // this destination yet. A revision-tagged geometry evaluation
                                    // is the deterministic layout-readiness handshake. It only
                                    // wakes the sole delivery task; it never performs a scroll.
                                    markInitialBottomReady(for: signal.contentRevision)
                                }
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 16)
                        .padding(.bottom, 22)
                    }
                    .opacity(isRestoringReadingPosition ? 0 : 1)
                    .scrollDismissesKeyboard(.interactively)
                    .scrollIndicators(.hidden)
                    .scrollPosition($transcriptScrollPosition)
                    .accessibilityIdentifier("chat.transcript")
                    .accessibilityValue(transcriptScrollDiagnostics)
                    .gesture(
                        TranscriptKeyboardDismissGesture {
                            UIApplication.shared.sendAction(
                                #selector(UIResponder.resignFirstResponder),
                                to: nil,
                                from: nil,
                                for: nil
                            )
                        }
                    )
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 2)
                            .onChanged { _ in stopFollowingTailForReveal() }
                    )
                    .onScrollGeometryChange(for: CGFloat.self) { geometry in
                        max(0, geometry.contentSize.height - geometry.visibleRect.maxY)
                    } action: { _, bottomDistance in
                        let wasNearBottom = isNearBottom
                        let stateChanged = scrollCoordinator.observeGeometry(
                            bottomDistance: Double(bottomDistance),
                            threshold: Double(bottomProximityThreshold)
                        )
                        if isNearBottom, !wasNearBottom {
                            if unseenCount > 0 {
                                unseenTracker.markReaderAtBottom()
                                unseenCount = 0
                            }
                        }
                        if stateChanged {
                            recordReadingPosition()
                        }
                    }
                    .onScrollPhaseChange { _, newPhase, context in
                        guard newPhase == .interacting else { return }
                        let wasNearBottom = isNearBottom
                        let geometry = context.geometry
                        let bottomDistance = max(
                            0,
                            geometry.contentSize.height - geometry.visibleRect.maxY
                        )
                        let stateChanged = scrollCoordinator.beginUserInteraction(
                            bottomDistance: Double(bottomDistance),
                            threshold: Double(bottomProximityThreshold)
                        )
                        if isNearBottom, !wasNearBottom {
                            unseenTracker.markReaderAtBottom()
                            unseenCount = 0
                        }
                        if stateChanged {
                            recordReadingPosition()
                        }
                    }
                    .onScrollTargetVisibilityChange(
                        idType: String.self,
                        threshold: 0.01
                    ) { identifiers in
                        if visibleEntryIDs != identifiers {
                            visibleEntryIDs = identifiers
                        }
                        if let restorationTargetEventID,
                           restorationScrollPerformed,
                           identifiers.contains(restorationTargetEventID) {
                            finishReadingPositionRestoration()
                        }
                        recordReadingPosition()
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if !isNearBottom {
                            scrollToBottomButton {
                                requestScroll(
                                    to: .bottom,
                                    source: .userLatest,
                                    animated: true
                                )
                            }
                            .padding(.trailing, 16)
                            .padding(.bottom, 12)
                            .transition(
                                reduceMotion
                                    ? .identity
                                    : .move(edge: .bottom).combined(with: .opacity)
                            )
                        }
                    }

                bottomControls(
                    queuedEntries: queuedEntries,
                    onThinkingTap: revealLiveReasoning
                )
            }
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.18),
                value: isNearBottom
            )
            .task(id: renderedScrollDeliveryRevision) {
                // Unlike onChange, an id-scoped task also runs for the value installed with a
                // newly rendered transcript. A newer revision cancels this task before the
                // coordinator is consumed, coalescing same-turn producers at one boundary.
                await Task.yield()
                guard !Task.isCancelled,
                      renderedScrollDeliveryRevision.contentRevision
                        == scrollContentRevision,
                      let pendingRequest = scrollCoordinator.pendingRequest else { return }
                if pendingRequest.source == .initial {
                    guard renderedScrollDeliveryRevision.initialBottomReadyRevision
                        == renderedScrollRevision else { return }
                }
                guard let request = scrollCoordinator.takePendingRequest() else { return }
                performScroll(to: request)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { headerToolbar }
        .sheet(item: $selectedToolDetail) { route in
            CompanionToolRunDetailView(tool: route.tool, timestamp: route.timestamp)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .task(id: companion.id) {
            await reload()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled { await reload(silently: true, isPolling: true) }
            }
        }
        .task(id: decisionCatalogTaskID) {
            guard decisionCatalogTaskID != nil else { return }
            await loadDecisionCatalog()
        }
        .onChange(of: companion) {
            guard currentCompanion.id != companion.id else {
                if currentCompanion != companion {
                    currentCompanion = companion
                }
                return
            }
            recordReadingPosition()
            currentCompanion = companion
            pendingReadingPosition = readingPosition
            resetTranscriptState()
        }
        .onDisappear { recordReadingPosition() }
        .onChange(of: liveReasoningEventID) { oldValue, newValue in
            if oldValue != newValue, let oldValue {
                expandedReasoningEventIDs.remove(oldValue)
            }
        }
        .onDisappear {
            cancelAssistantTailReveal()
        }
    }

    @ToolbarContentBuilder
    private var headerToolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            HStack(spacing: 9) {
                CompanionAvatar(
                    name: currentCompanion.name,
                    icon: currentCompanion.icon,
                    size: 32,
                    state: isReplying ? .thinking : .idle
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
            .tint(visualTheme.accent)
            .accessibilityLabel("Settings for \(currentCompanion.name)")
            .accessibilityIdentifier("chat.settings")
        }
    }

    private var loadEarlierButton: some View {
        Button {
            Task { await loadEarlier() }
        } label: {
            Group {
                if loadingEarlier {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Label("Load earlier messages", systemImage: "arrow.up")
                }
            }
            .font(.caption.weight(.semibold))
            .frame(minHeight: 44)
            .padding(.horizontal, 14)
        }
        .buttonStyle(.glass)
        .tint(visualTheme.accent)
        .disabled(loadingEarlier)
        .accessibilityLabel("Load earlier messages")
        .accessibilityIdentifier("chat.load-earlier")
    }

    private func scrollToBottomButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: unseenCount > 0 ? 8 : 0) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: unseenCount > 0 ? nil : 46, height: 46)
                if unseenCount > 0 {
                    Text(unseenMessage(count: unseenCount))
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }
            }
            .frame(minHeight: 46)
            .padding(.horizontal, unseenCount > 0 ? 14 : 0)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(unseenCount > 0 ? .capsule : .circle)
        .tint(visualTheme.accent)
        .shadow(color: visualTheme.shadow.opacity(0.2), radius: 8, y: 3)
        .accessibilityLabel(
            unseenCount > 0
                ? "\(unseenMessage(count: unseenCount)). Scroll to latest message"
                : "Scroll to latest message"
        )
        .accessibilityValue(unseenCount > 0 ? unseenMessage(count: unseenCount) : "")
        .accessibilityHint("Double tap to scroll to the latest message.")
        .accessibilityIdentifier("chat.scroll-to-bottom")
    }

    private func unseenMessage(count: Int) -> String {
        count == 1 ? "1 new reply" : "\(count) new replies"
    }

    private func dayMarker(for date: Date) -> some View {
        Text(dayLabel(for: date))
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.companionMuted)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.thinMaterial, in: Capsule())
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("chat.day-marker.\(dayLabel(for: date))")
    }

    private func unavailableState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Conversation unavailable", systemImage: "exclamationmark.bubble")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await reload() } }
                .buttonStyle(.glassProminent)
                .tint(visualTheme.accent)
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
    private func bottomControls(
        queuedEntries: [TranscriptEntry],
        onThinkingTap: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 8) {
            if !queuedEntries.isEmpty {
                CompanionQueuedMessagesView(
                    entries: queuedEntries,
                    canManage: thread?.canSend == true,
                    viewerID: thread?.viewerID,
                    accent: visualTheme.accent,
                    onRemove: cancelTurn
                )
                .padding(.horizontal, 12)
            }

            ChatComposer(
                companionID: currentCompanion.id,
                companionName: currentCompanion.name,
                companionIcon: currentCompanion.icon,
                canSend: thread?.canSend,
                transcriptionAvailable: thread?.transcriptionAvailable == true,
                isReplying: isReplying,
                hasLiveReasoning: liveReasoningEventID != nil,
                error: thread == nil ? nil : error,
                sending: sending,
                accent: visualTheme.accent,
                accentForeground: visualTheme.accentForeground,
                onThinkingTap: onThinkingTap,
                onSend: send(content:attachments:)
            )
        }
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: currentCompanion.icon)
    }

    private var isNearBottom: Bool {
        scrollCoordinator.isFollowingTail
    }

    private var isReplying: Bool {
        guard let thread else { return currentCompanion.runtime.replying }
        return thread.activeTurn?.replying == true
    }

    private var liveReasoningEventID: String? {
        guard isReplying,
              let attemptID = thread?.activeTurn?.latestAttempt?.id.lowercased() else {
            return nil
        }
        let eventPrefix = "v2:\(attemptID):"
        return entries.last(where: { entry in
            entry.role == "assistant"
                && entry.eventID.lowercased().hasPrefix(eventPrefix)
                && nonEmptyReasoning(entry.reasoning)
        })?.eventID
    }

    private func nonEmptyReasoning(_ value: String?) -> Bool {
        guard let value else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func setReasoningExpanded(_ isExpanded: Bool, for eventID: String) {
        if isExpanded {
            expandedReasoningEventIDs.insert(eventID)
        } else {
            expandedReasoningEventIDs.remove(eventID)
        }
    }

    private func transcriptRowInput(for entry: TranscriptEntry) -> TranscriptRowInput {
        TranscriptRowInput(
            entry: entry,
            own: entry.role == "user" && entry.authorID == thread?.viewerID,
            companionID: currentCompanion.id,
            companionName: currentCompanion.name,
            companionIcon: currentCompanion.icon,
            markdown: markdownByEventID[entry.eventID]?.document,
            tailReveal: assistantTailReveal?.eventID == entry.eventID
                ? assistantTailReveal
                : nil,
            reasoningExpanded: expandedReasoningEventIDs.contains(entry.eventID),
            canAct: thread?.canSend == true,
            decisionCatalog: entry.decision == nil ? .empty : decisionCatalog
        )
    }

    private func revealLiveReasoning() {
        guard let eventID = liveReasoningEventID else { return }
        if reduceMotion {
            expandedReasoningEventIDs.insert(eventID)
            requestScroll(
                to: .entry(eventID),
                source: .reasoning,
                animated: false
            )
        } else {
            withAnimation(.easeInOut(duration: 0.2)) {
                expandedReasoningEventIDs.insert(eventID)
            }
            requestScroll(
                to: .entry(eventID),
                source: .reasoning,
                animated: true
            )
        }
    }

    private var statusLabel: String {
        if isReplying { return "Replying" }
        switch currentCompanion.runtime.state {
        case .running: return "Online"
        case .provisioning: return "Starting"
        case .stopping: return "Stopping"
        case .error: return "Needs attention"
        case .notCreated, .stopped: return "Asleep"
        case .unknown: return "Unknown"
        }
    }

    private func reload(silently: Bool = false, isPolling: Bool = false) async {
        if silently, loadingEarlier { return }
        if !isPolling { cancelAssistantTailReveal() }
        let generation = refreshGate.begin()
        let previousThread = threadProjection.thread
        let hasPreviousThread = previousThread != nil
        if !silently { loading = true }
        do {
            let next: CompanionThread
            if let services {
                next = try await services.thread(companion.id)
            } else {
                next = try await sessionStore.thread(companionID: companion.id)
            }
            guard refreshGate.accepts(generation) else { return }
            let readerWasNearBottom = isNearBottom

            let previousEntries = previousThread.map { transcriptEntries(in: $0) } ?? []
            let nextEntries = transcriptEntries(in: next)
            var nextWindow = transcriptWindow
            let restoration = previousThread == nil ? pendingReadingPosition : nil
            let restorationAnchorIndex = restoration.flatMap { position in
                nextEntries.firstIndex { $0.eventID == position.anchorEventID }
            }
            if let restoration, !restoration.isFollowingTail, let restorationAnchorIndex {
                nextWindow.restore(
                    totalCount: nextEntries.count,
                    previouslyExposedCount: restoration.exposedEntryCount,
                    previousTotalCount: restoration.transcriptEntryCount,
                    anchorIndex: restorationAnchorIndex
                )
            } else {
                nextWindow.refresh(
                    totalCount: nextEntries.count,
                    preservingCurrentEntries: !readerWasNearBottom
                )
            }
            let visibleRange = nextWindow.visibleRange(for: nextEntries.count)
            let pollDiff = CompanionTranscriptPollDiff(
                previous: previousEntries,
                next: nextEntries,
                nextVisibleRange: visibleRange
            )
            let transcriptChanged = previousThread == nil || !pollDiff.isIdentical
            let visibleTranscriptChanged = previousThread == nil
                || pollDiff.hasVisibleChanges
                || transcriptWindow != nextWindow
            let renderedMarkdown = visibleTranscriptChanged
                ? await renderedMarkdown(for: Array(nextEntries[visibleRange]))
                : markdownByEventID
            guard refreshGate.accepts(generation) else { return }

            let tailChange = isPolling
                ? assistantTailChange(from: previousThread, to: next)
                : nil
            let tailBaseMarkdown = tailChange.flatMap {
                markdownByEventID[$0.eventID]?.document
            }

            let persistedEventIDs = Set(next.entries.map(\.eventID))
            let reconciledPendingMessages = pendingMessages.filter { pending in
                !persistedEventIDs.contains("msg:\(pending.id.uuidString.lowercased())")
            }
            let pendingChanged = reconciledPendingMessages.count != pendingMessages.count
            if pendingChanged {
                pendingMessages = reconciledPendingMessages
            }
            let restorationTarget = restoration.flatMap { position -> String? in
                guard !position.isFollowingTail, restorationAnchorIndex != nil else { return nil }
                return position.anchorEventID
            }
            if transcriptWindow != nextWindow {
                transcriptWindow = nextWindow
            }
            if !markdownCachesEqual(markdownByEventID, renderedMarkdown) {
                markdownByEventID = renderedMarkdown
            }
            if previousThread != next {
                threadProjection.update(next)
            }
            let tailChanged = observeActualTail(
                of: next,
                source: hasPreviousThread ? .poll : .initial
            )
            let readerIsNearBottom = isNearBottom
            if transcriptChanged {
                var nextUnseenTracker = unseenTracker
                let nextUnseenCount = nextUnseenTracker.observe(
                    entries: nextEntries,
                    isNearBottom: readerIsNearBottom
                )
                if nextUnseenTracker != unseenTracker {
                    unseenTracker = nextUnseenTracker
                }
                if nextUnseenCount != unseenCount {
                    unseenCount = nextUnseenCount
                }
            }
            let shouldFollowTail = !loadingEarlier
                && previousThread != nil
                && tailChanged
                && readerIsNearBottom
            refreshSelectedToolDetail(from: next.entries)
            if error != nil {
                error = nil
            }
            if let restorationTarget {
                if !isRestoringReadingPosition {
                    isRestoringReadingPosition = true
                }
                if restorationTargetEventID != restorationTarget {
                    restorationTargetEventID = restorationTarget
                }
                restorationScrollPerformed = false
                requestScroll(
                    to: .entry(restorationTarget),
                    source: .restoration,
                    animated: false
                )
            } else {
                if pendingReadingPosition != nil {
                    pendingReadingPosition = nil
                }
                if isRestoringReadingPosition {
                    isRestoringReadingPosition = false
                }
                if restorationTargetEventID != nil {
                    restorationTargetEventID = nil
                }
                restorationScrollPerformed = false
                if restoration != nil, restorationAnchorIndex == nil {
                    scrollCoordinator.setFollowState(.followingTail)
                }
            }
            if isPolling {
                if let tailChange {
                    startAssistantTailReveal(
                        for: tailChange,
                        baseMarkdown: tailBaseMarkdown,
                        followTail: shouldFollowTail
                    )
                } else {
                    cancelAssistantTailReveal()
                }
            }
        } catch {
            guard refreshGate.accepts(generation) else { return }
            self.error = "The conversation could not be refreshed."
        }

        let refreshed: CompanionSummary?
        if let services {
            refreshed = try? await services.listCompanions().first(where: { $0.id == companion.id })
        } else {
            refreshed = try? await sessionStore.listCompanions().first(where: { $0.id == companion.id })
        }
        if let refreshed {
            guard refreshGate.accepts(generation) else { return }
            if currentCompanion != refreshed {
                currentCompanion = refreshed
            }
        }
        if refreshGate.accepts(generation), loading {
            loading = false
        }
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

    private func markdownCachesEqual(
        _ lhs: [String: CachedMarkdownDocument],
        _ rhs: [String: CachedMarkdownDocument]
    ) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return lhs.allSatisfy { eventID, cached in
            guard let other = rhs[eventID] else { return false }
            return cached.source == other.source && cached.document == other.document
        }
    }

    private func assistantTailChange(
        from previous: CompanionThread?,
        to next: CompanionThread
    ) -> AssistantTailChange? {
        guard let previous,
              next.activeTurn?.replying == true else {
            return nil
        }

        let previousEntries = transcriptEntries(in: previous)
        let nextEntries = transcriptEntries(in: next)
        guard let nextTail = nextEntries.last,
              nextTail.role == "assistant",
              !nextTail.content.isEmpty else {
            return nil
        }

        if let previousTail = previousEntries.last,
           previousTail.eventID == nextTail.eventID,
           nextTail.content.count > previousTail.content.count,
           nextTail.content.hasPrefix(previousTail.content) {
            return AssistantTailChange(
                eventID: nextTail.eventID,
                previousContent: previousTail.content,
                nextContent: nextTail.content
            )
        }

        let previousIDs = Set(previousEntries.map(\.eventID))
        guard !previousIDs.contains(nextTail.eventID),
              nextEntries.count > previousEntries.count,
              nextTail.ordinal > (previousEntries.last?.ordinal ?? Int.min) else {
            return nil
        }
        return AssistantTailChange(
            eventID: nextTail.eventID,
            previousContent: "",
            nextContent: nextTail.content
        )
    }

    private func startAssistantTailReveal(
        for change: AssistantTailChange,
        baseMarkdown: MarkdownDocument?,
        followTail: Bool
    ) {
        assistantTailRevealTask?.cancel()
        guard change.nextContent.hasPrefix(change.previousContent),
              change.nextContent != change.previousContent else {
            assistantTailReveal = nil
            assistantTailRevealTask = nil
            return
        }

        guard !reduceMotion else {
            assistantTailReveal = nil
            assistantTailRevealTask = nil
            return
        }

        let revealID = UUID()
        let delta = String(change.nextContent.dropFirst(change.previousContent.count))
        let deltaCharacters = delta.count
        assistantTailReveal = AssistantTailReveal(
            id: revealID,
            eventID: change.eventID,
            baseMarkdown: baseMarkdown,
            visibleDelta: "",
            followsTail: followTail
        )

        let task = Task { @MainActor in
            // Eight short updates keep the reveal near 200ms while making cancellation cheap.
            for step in 1...8 {
                do {
                    try await Task.sleep(for: .milliseconds(25))
                } catch {
                    return
                }
                guard let reveal = assistantTailReveal, reveal.id == revealID else { return }
                let characterCount = deltaCharacters * step / 8
                assistantTailReveal = AssistantTailReveal(
                    id: revealID,
                    eventID: change.eventID,
                    baseMarkdown: baseMarkdown,
                    visibleDelta: String(delta.prefix(characterCount)),
                    followsTail: reveal.followsTail
                )
            }

            guard let completedReveal = assistantTailReveal,
                  completedReveal.id == revealID else { return }
            assistantTailReveal = nil
            assistantTailRevealTask = nil
            if completedReveal.followsTail, isNearBottom, !loadingEarlier {
                // Text height can grow after the original follow-tail scroll. Re-anchor once the
                // final markdown document is restored so a reader following the tail is not left
                // just above the bottom.
                requestScroll(
                    to: .bottom,
                    source: .poll,
                    animated: false
                )
            }
        }
        assistantTailRevealTask = task
    }

    private func stopFollowingTailForReveal() {
        guard var reveal = assistantTailReveal, reveal.followsTail else { return }
        reveal.followsTail = false
        assistantTailReveal = reveal
    }

    private func cancelAssistantTailReveal() {
        guard assistantTailRevealTask != nil || assistantTailReveal != nil else { return }
        assistantTailRevealTask?.cancel()
        assistantTailRevealTask = nil
        assistantTailReveal = nil
    }

    private var entries: [TranscriptEntry] {
        guard let thread else { return [] }
        let visibleTranscript = transcriptEntries(in: thread)
        return Array(
            visibleTranscript[transcriptWindow.visibleRange(for: visibleTranscript.count)]
        )
    }

    private func transcriptEntries(in thread: CompanionThread?) -> [TranscriptEntry] {
        guard let thread else { return [] }
        return thread.entries
            .filter { !$0.queued }
            .sorted(by: transcriptOrder)
    }

    private func queuedEntries(in thread: CompanionThread?) -> [TranscriptEntry] {
        guard let thread else { return [] }
        return thread.entries
            .filter(\.queued)
            .sorted(by: transcriptOrder)
    }

    private func transcriptOrder(_ lhs: TranscriptEntry, _ rhs: TranscriptEntry) -> Bool {
        lhs.ordinal == rhs.ordinal ? lhs.eventID < rhs.eventID : lhs.ordinal < rhs.ordinal
    }

    private func refreshSelectedToolDetail(from entries: [TranscriptEntry]) {
        guard let selectedToolDetail else { return }
        guard let entry = entries.first(where: { $0.eventID == selectedToolDetail.id }),
              let tool = entry.tool else {
            self.selectedToolDetail = nil
            return
        }
        let nextRoute = ToolRunDetailRoute(
            id: entry.eventID,
            tool: tool,
            timestamp: toolTimestamp(for: entry)
        )
        guard selectedToolDetail.id != nextRoute.id
                || selectedToolDetail.tool != nextRoute.tool
                || selectedToolDetail.timestamp != nextRoute.timestamp else {
            return
        }
        self.selectedToolDetail = nextRoute
    }

    private func toolTimestamp(for entry: TranscriptEntry) -> String? {
        guard let date = parseCompanionTimestamp(entry.createdAt) else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
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
        guard let last = entries.last(where: { !$0.queued }),
              let date = transcriptDate(last.createdAt) else { return true }
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

    @discardableResult
    private func observeActualTail(
        of thread: CompanionThread,
        source: CompanionScrollRequestSource
    ) -> Bool {
        let previousRequest = scrollCoordinator.pendingRequest
        let changed = scrollCoordinator.observeTail(of: thread, source: source)
        if previousRequest != scrollCoordinator.pendingRequest {
            scrollContentRevision &+= 1
        }
        return changed
    }

    private func loadEarlier() async {
        guard !loadingEarlier, transcriptWindow.hasEarlierEntries,
              let firstEventID = entries.first?.eventID,
              let snapshot = thread else { return }

        var expandedWindow = transcriptWindow
        guard expandedWindow.loadEarlier() else { return }
        cancelAssistantTailReveal()
        loadingEarlier = true
        refreshGate.invalidate()
        let snapshotEntries = transcriptEntries(in: snapshot)
        let visibleRange = expandedWindow.visibleRange(for: snapshotEntries.count)
        let renderedMarkdown = await renderedMarkdown(
            for: Array(snapshotEntries[visibleRange])
        )
        guard thread?.entries == snapshot.entries else {
            loadingEarlier = false
            return
        }

        if !markdownCachesEqual(markdownByEventID, renderedMarkdown) {
            markdownByEventID = renderedMarkdown
        }
        if transcriptWindow != expandedWindow {
            transcriptWindow = expandedWindow
        }
        requestScroll(
            to: .entry(firstEventID),
            source: .loadEarlier,
            animated: false
        )
    }

    private func requestScroll(
        to destination: CompanionScrollDestination,
        source: CompanionScrollRequestSource,
        animated: Bool
    ) {
        if case .bottom = destination {
            guard !loadingEarlier else { return }
            pendingReadingPosition = nil
            isRestoringReadingPosition = false
            restorationTargetEventID = nil
            if source == .userLatest {
                unseenTracker.markReaderAtBottom()
                unseenCount = 0
            }
        }
        scrollCoordinator.request(
            CompanionScrollRequest(
                destination: destination,
                source: source,
                animated: animated
            )
        )
        scrollContentRevision &+= 1
    }

    private func recordReadingPosition() {
        guard !isRestoringReadingPosition, !loadingEarlier, let thread else { return }
        let transcript = transcriptEntries(in: thread)
        let visibleIDs = Set(visibleEntryIDs)
        guard let anchor = transcript.first(where: { visibleIDs.contains($0.eventID) }) else {
            return
        }
        let position = CompanionChatReadingPosition(
            anchorEventID: anchor.eventID,
            isFollowingTail: isNearBottom,
            exposedEntryCount: transcriptWindow.exposedCount,
            transcriptEntryCount: transcript.count
        )
        guard position != lastReportedReadingPosition else { return }
        lastReportedReadingPosition = position
        onReadingPositionChange(position)
    }

    private func performScroll(to request: CompanionScrollRequest) {
        switch request.destination {
        case .bottom:
            // ScrollPosition retains this requested identity across the lazy stack's layout
            // commit. A one-shot ScrollViewProxy request can be accepted in the same transaction
            // that reports destination readiness and then silently discarded on long threads.
            let targetID = bottomScrollTargetID
            if reduceMotion || !request.animated {
                transcriptScrollPosition.scrollTo(id: targetID, anchor: .bottom)
            } else {
                withAnimation(.easeOut(duration: 0.18)) {
                    transcriptScrollPosition.scrollTo(id: targetID, anchor: .bottom)
                }
            }
        case .entry(let eventID):
            let anchor: UnitPoint = request.source == .reasoning ? .center : .top
            if reduceMotion || !request.animated {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    transcriptScrollPosition.scrollTo(id: eventID, anchor: anchor)
                }
            } else {
                withAnimation(.easeInOut(duration: 0.2)) {
                    transcriptScrollPosition.scrollTo(id: eventID, anchor: anchor)
                }
            }
            if request.source == .restoration {
                restorationScrollPerformed = true
            }
            if restorationTargetEventID == eventID {
                Task { @MainActor in
                    await Task.yield()
                    await Task.yield()
                    if restorationTargetEventID == eventID {
                        finishReadingPositionRestoration()
                    }
                }
            } else {
                pendingReadingPosition = nil
                isRestoringReadingPosition = false
            }
            loadingEarlier = false
        }
    }

    private var bottomScrollTargetID: String {
        if let pending = pendingMessages.last {
            return "pending-\(pending.id)"
        }
        if let interruptedTurn = thread?.interruptedTurn {
            return "interrupted-\(interruptedTurn.id)"
        }
        return entries.last?.id ?? "bottom"
    }

    private func markInitialBottomReady(for renderedRevision: Int) {
        guard renderedRevision == scrollContentRevision,
              initialBottomReadyRevision != renderedRevision else { return }
        initialBottomReadyRevision = renderedRevision
    }

    private var transcriptScrollDiagnostics: String {
        guard ProcessInfo.processInfo.arguments.contains(
            "-companion-transcript-window-demo"
        ) else { return "" }
        return [
            "revision=\(scrollContentRevision)",
            "ready=\(initialBottomReadyRevision.map(String.init) ?? "none")",
            "pending=\(scrollCoordinator.pendingRequest?.source.rawValue ?? "none")",
            "batches=\(scrollCoordinator.issuedRequestBatchCount)",
            "outstanding=\(scrollCoordinator.isProgrammaticBottomScrollOutstanding)",
            "follow=\(scrollCoordinator.followState.rawValue)",
            "target=\(bottomScrollTargetID)",
        ].joined(separator: ";")
    }

    private func finishReadingPositionRestoration() {
        restorationTargetEventID = nil
        restorationScrollPerformed = false
        pendingReadingPosition = nil
        isRestoringReadingPosition = false
    }

    private func resetTranscriptState() {
        cancelAssistantTailReveal()
        refreshGate.invalidate()
        threadProjection.reset()
        transcriptWindow.reset()
        unseenTracker.reset()
        unseenCount = 0
        pendingMessages = []
        markdownByEventID = [:]
        decisionCatalog = .empty
        decisionCatalogLoaded = false
        selectedToolDetail = nil
        loading = true
        loadingEarlier = false
        scrollCoordinator.reset(
            followState: pendingReadingPosition?.isFollowingTail == false
                ? .userReading
                : .followingTail
        )
        visibleEntryIDs = []
        isRestoringReadingPosition = false
        restorationTargetEventID = nil
        restorationScrollPerformed = false
        lastReportedReadingPosition = nil
        initialBottomReadyRevision = nil
        transcriptScrollPosition = ScrollPosition(idType: String.self)
        scrollContentRevision &+= 1
    }

    private func send(content: String, attachments: [CompanionMessageAttachment]) {
        guard !content.isEmpty, !sending else { return }
        let message = PendingMessage(
            id: UUID(),
            content: content,
            attachments: attachments,
            failed: false,
            uploadProgress: attachments.isEmpty ? nil : 0
        )
        pendingMessages.append(message)
        if isNearBottom {
            requestScroll(
                to: .bottom,
                source: .localSend,
                animated: true
            )
        }
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
        cancelAssistantTailReveal()
        refreshGate.invalidate()

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

            refreshGate.invalidate()
            threadProjection.replaceAfterMutation(with: next)
            _ = observeActualTail(of: next, source: .poll)
            let nextEntries = transcriptEntries(in: next)
            var nextWindow = transcriptWindow
            nextWindow.refresh(totalCount: nextEntries.count)
            let visibleRange = nextWindow.visibleRange(for: nextEntries.count)
            let renderedMarkdown = await renderedMarkdown(
                for: Array(nextEntries[visibleRange])
            )
            if transcriptWindow != nextWindow {
                transcriptWindow = nextWindow
            }
            if !markdownCachesEqual(markdownByEventID, renderedMarkdown) {
                markdownByEventID = renderedMarkdown
            }
            await threadMutationGate.release(mutationID: mutationID)
        } catch {
            refreshGate.invalidate()
            await reload(silently: true)
            await threadMutationGate.release(mutationID: mutationID)
            throw error
        }
    }

    private func retryInterruptedTurn(
        turnID: String,
        retryID: UUID
    ) async throws -> CompanionOperationSummary {
        cancelAssistantTailReveal()
        refreshGate.invalidate()
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
        cancelAssistantTailReveal()
        refreshGate.invalidate()
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
            refreshGate.invalidate()
            threadProjection.replaceAfterMutation(with: next)
            _ = observeActualTail(of: next, source: .poll)
            let nextEntries = transcriptEntries(in: next)
            var nextWindow = transcriptWindow
            nextWindow.refresh(totalCount: nextEntries.count)
            let visibleRange = nextWindow.visibleRange(for: nextEntries.count)
            let renderedMarkdown = await renderedMarkdown(
                for: Array(nextEntries[visibleRange])
            )
            if transcriptWindow != nextWindow {
                transcriptWindow = nextWindow
            }
            if !markdownCachesEqual(markdownByEventID, renderedMarkdown) {
                markdownByEventID = renderedMarkdown
            }
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
        if let refreshed, currentCompanion != refreshed {
            currentCompanion = refreshed
        }
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
    var markdown: MarkdownDocument?
    var streamingBaseMarkdown: MarkdownDocument? = nil
    var streamingDelta: String? = nil
    var reasoning: String? = nil
    var reasoningExpansion: Binding<Bool>? = nil
    var attachments: [CompanionAttachment] = []
    var localAttachments: [CompanionMessageAttachment] = []

    @State private var localReasoningExpanded = false

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
        .companionMessageInteractionMenu(rawContent: content)
    }

    @ViewBuilder
    private var bubble: some View {
        let contentView = VStack(alignment: .leading, spacing: 6) {
            if kind != .mine, let authorName {
                Text(authorName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
            }

            if kind == .assistant, let reasoning = displayReasoning {
                CompanionThinkingDisclosure(
                    reasoning: reasoning,
                    isExpanded: reasoningExpansion ?? $localReasoningExpanded
                )
            }

            if kind == .assistant, let streamingDelta {
                if let streamingBaseMarkdown {
                    MarkdownMessageView(
                        document: streamingBaseMarkdown,
                        accent: .companionInk,
                        allowsTextSelection: false
                    )
                }
                if !streamingDelta.isEmpty {
                    Text(streamingDelta)
                        .font(.body)
                        .foregroundStyle(Color.companionInk)
                        .lineSpacing(3)
                }
            } else if kind == .assistant, let markdown {
                MarkdownMessageView(
                    document: markdown,
                    accent: .companionInk,
                    allowsTextSelection: false
                )
            } else {
                Text(content)
                    .font(.body)
                    .foregroundStyle(Color.companionInk)
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
                .companionMaterial(radius: 18)
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

    private var displayReasoning: String? {
        guard let reasoning else { return nil }
        guard !reasoning.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return reasoning
    }
}

struct CompanionThinkingDisclosure: View {
    let reasoning: String
    @Binding var isExpanded: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var secondaryStyle: Color { Color(uiColor: .secondaryLabel) }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            Text(reasoning)
                .font(.footnote)
                .foregroundStyle(secondaryStyle)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 4)
                .padding(.top, 2)
                .accessibilityIdentifier("thinking.content")
        } label: {
            Text("Thinking")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(secondaryStyle)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .tint(secondaryStyle)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Thinking")
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityHint(
            isExpanded
                ? "Double tap to collapse thinking."
                : "Double tap to expand thinking."
        )
        .accessibilityIdentifier("thinking.disclosure")
        .transaction { transaction in
            if reduceMotion {
                transaction.animation = nil
            }
        }
    }
}

struct CompanionThinkingStatus: View {
    let companionName: String
    let icon: CompanionSummary.Icon?
    let accent: Color
    let isInteractive: Bool
    let onTap: () -> Void

    private var label: String { "\(companionName) thinking" }

    private var statusTextColor: Color { Color(uiColor: .label) }

    @ViewBuilder
    var body: some View {
        if isInteractive {
            Button(action: onTap) {
                statusContent
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityValue("Details available")
            .accessibilityHint("Double tap to show current thinking.")
            .accessibilityIdentifier("chat.thinking-status")
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            statusContent
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label)
                .accessibilityValue("Thinking details not available yet")
                .accessibilityHint("Thinking details are not available yet.")
                .accessibilityIdentifier("chat.thinking-status")
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var statusContent: some View {
        HStack(spacing: 9) {
            CompanionAvatar(name: companionName, icon: icon, size: 28, state: .thinking)
                .accessibilityHidden(true)

            HStack(spacing: 0) {
                Text(companionName)
                    .foregroundStyle(statusTextColor)
                    .fontWeight(.semibold)
                Text(" thinking")
                    .foregroundStyle(Color(uiColor: .secondaryLabel))
            }
            .font(.subheadline)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)

            if isInteractive {
                Image(systemName: "chevron.up")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(accent)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 44, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .contentShape(.rect(cornerRadius: 16))
        .companionGlass(radius: 16, tint: accent.opacity(0.08), interactive: isInteractive)
    }
}

private struct TranscriptRowInput: Equatable {
    let entry: TranscriptEntry
    let own: Bool
    let companionID: String
    let companionName: String
    let companionIcon: CompanionSummary.Icon?
    let markdown: MarkdownDocument?
    let tailReveal: AssistantTailReveal?
    let reasoningExpanded: Bool
    let canAct: Bool
    let decisionCatalog: CompanionDecisionCatalog
}

private struct TranscriptRowView: View, @MainActor Equatable {
    let input: TranscriptRowInput
    let onDecide: @MainActor (CompanionDecisionAction) async throws -> Void
    let onOpenPlugins: () -> Void
    let onReasoningExpansionChange: (Bool) -> Void
    let onOpenToolDetails: (ToolRunDetailRoute) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.input == rhs.input
    }

    @ViewBuilder
    var body: some View {
        if let decision = input.entry.decision {
            CompanionDecisionCard(
                decision: decision,
                companionName: input.companionName,
                canAct: input.canAct,
                catalog: input.decisionCatalog,
                accent: visualTheme.accent,
                accentForeground: visualTheme.accentForeground,
                onDecide: onDecide,
                onOpenPlugins: onOpenPlugins
            )
        } else if input.entry.role == "tool", let tool = input.entry.tool {
            CompanionToolRunCard(tool: tool, eventID: input.entry.eventID) {
                onOpenToolDetails(ToolRunDetailRoute(
                    id: input.entry.eventID,
                    tool: tool,
                    timestamp: timeLabel
                ))
            }
        } else {
            ChatMessageBubble(
                content: input.entry.content,
                kind: kind,
                authorName: input.own
                    ? nil
                    : input.entry.authorName
                        ?? (input.entry.role == "user" ? "Workspace member" : input.companionName),
                timestamp: timeLabel,
                queued: input.entry.queued,
                companionName: input.companionName,
                companionID: input.companionID,
                icon: input.companionIcon,
                markdown: input.entry.role == "assistant" ? input.markdown : nil,
                streamingBaseMarkdown: input.tailReveal?.baseMarkdown,
                streamingDelta: input.tailReveal?.visibleDelta,
                reasoning: input.entry.role == "assistant" ? input.entry.reasoning : nil,
                reasoningExpansion: Binding(
                    get: { input.reasoningExpanded },
                    set: onReasoningExpansionChange
                ),
                attachments: input.entry.attachments
            )
            .accessibilityIdentifier("chat.entry.\(input.entry.eventID)")
        }
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: input.companionIcon)
    }

    private var kind: ChatMessageBubble.Kind {
        if input.own { return .mine }
        return input.entry.role == "user" ? .member : .assistant
    }

    private var timeLabel: String? {
        guard let date = parseCompanionTimestamp(input.entry.createdAt) else { return nil }
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
                localAttachments: message.attachments
            )

            if let progress = message.uploadProgress, !message.failed {
                ProgressView(value: progress)
                    .tint(Color.companionMuted)
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
