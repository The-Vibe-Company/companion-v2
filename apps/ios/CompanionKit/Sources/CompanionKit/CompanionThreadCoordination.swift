/// Owns the currently rendered thread and rejects refreshes that were started before a newer read
/// or mutation response. The decision endpoint's transactional response is always authoritative.
public struct CompanionThreadProjection: Equatable, Sendable {
    public private(set) var thread: CompanionThread?
    private var revision = 0

    public init(thread: CompanionThread? = nil) {
        self.thread = thread
    }

    public mutating func beginRefresh() -> Int {
        revision += 1
        return revision
    }

    public func accepts(refresh revision: Int) -> Bool {
        revision == self.revision
    }

    @discardableResult
    public mutating func accept(_ thread: CompanionThread, refresh revision: Int) -> Bool {
        guard accepts(refresh: revision) else { return false }
        self.thread = thread
        return true
    }

    public mutating func replaceAfterMutation(with thread: CompanionThread) {
        revision += 1
        self.thread = thread
    }

    public mutating func invalidateRefreshes() {
        revision += 1
    }

    /// Clears the projected thread while keeping refresh generations monotonic across resource
    /// changes. Replacing this value with a fresh projection could let an older request's numeric
    /// generation collide with the first refresh for the next Companion.
    public mutating func reset() {
        revision += 1
        thread = nil
    }
}

/// The two presentation modes of a transcript. This is deliberately separate from the server's
/// unread watermark: a reader can be looking at history while the Companion is still producing
/// newer entries.
public enum CompanionScrollFollowState: String, Equatable, Sendable {
    case followingTail
    case userReading
}

/// The operation which caused a scroll decision. Keeping this value in the shared package makes
/// the decision policy testable without constructing a SwiftUI view.
public enum CompanionScrollRequestSource: String, Equatable, Sendable {
    case initial
    case restoration
    case loadEarlier
    case poll
    case userLatest
    case localSend
    case reasoning
}

public enum CompanionScrollDestination: Equatable, Sendable {
    case bottom
    case entry(String)
}

public struct CompanionScrollRequest: Equatable, Sendable {
    public let destination: CompanionScrollDestination
    public let source: CompanionScrollRequestSource
    public let animated: Bool

    public init(
        destination: CompanionScrollDestination,
        source: CompanionScrollRequestSource,
        animated: Bool
    ) {
        self.destination = destination
        self.source = source
        self.animated = animated
    }
}

/// The only portion of a thread which can justify an automatic tail scroll.
///
/// Queued messages, queued counts, runtime status, and markdown cache changes are intentionally
/// absent. The last nonqueued entry is sorted in the same deterministic order as the transcript
/// window, and the interrupted turn is included because its presentation occupies the tail.
public struct CompanionScrollTailSnapshot: Equatable, Sendable {
    public let lastEntry: TranscriptEntry?
    public let interruptedTurn: CompanionTurn?

    public init(
        lastEntry: TranscriptEntry? = nil,
        interruptedTurn: CompanionTurn? = nil
    ) {
        self.lastEntry = lastEntry
        self.interruptedTurn = interruptedTurn
    }

    public init(thread: CompanionThread) {
        let lastEntry = thread.entries
            .filter { !$0.queued }
            .sorted {
                $0.ordinal == $1.ordinal ? $0.eventID < $1.eventID : $0.ordinal < $1.ordinal
            }
            .last
        self.init(lastEntry: lastEntry, interruptedTurn: thread.interruptedTurn)
    }
}

/// Owns transcript follow state and coalesces all requests made during one SwiftUI update.
///
/// A caller queues a request while it is updating its model, then consumes exactly one request
/// from `takePendingRequest()` after the update has rendered. Consumption is the physical-scroll
/// boundary: it increments `issuedRequestBatchCount` and, for a bottom request, establishes a
/// geometry guard until the bottom is observed. Geometry callbacks arriving before that point are
/// layout feedback, not user intent.
public struct CompanionScrollCoordinator: Equatable, Sendable {
    public private(set) var followState: CompanionScrollFollowState
    public private(set) var pendingRequest: CompanionScrollRequest?
    public private(set) var issuedRequestBatchCount: Int
    public private(set) var lastActualTailSnapshot: CompanionScrollTailSnapshot?

    private var observedTail = false
    private var initialSnapshotInstalled = false
    private var programmaticBottomScrollOutstanding = false

    public init(
        followState: CompanionScrollFollowState = .followingTail,
        lastActualTailSnapshot: CompanionScrollTailSnapshot? = nil
    ) {
        self.followState = followState
        self.pendingRequest = nil
        self.issuedRequestBatchCount = 0
        self.lastActualTailSnapshot = lastActualTailSnapshot
        self.observedTail = lastActualTailSnapshot != nil
        self.initialSnapshotInstalled = false
    }

    public var isFollowingTail: Bool {
        followState == .followingTail
    }

    public var isProgrammaticBottomScrollOutstanding: Bool {
        programmaticBottomScrollOutstanding
    }

    public mutating func setFollowState(_ state: CompanionScrollFollowState) {
        guard pendingRequest?.destination != .bottom,
              !programmaticBottomScrollOutstanding else { return }
        followState = state
    }

    /// Records a complete thread's actual visible tail and optionally queues the corresponding
    /// automatic follow decision. The initial installation always gets one request, including an
    /// empty thread, while identical later snapshots are no-ops.
    @discardableResult
    public mutating func observeTail(
        _ snapshot: CompanionScrollTailSnapshot,
        source: CompanionScrollRequestSource
    ) -> Bool {
        let changed = !observedTail || lastActualTailSnapshot != snapshot
        observedTail = true
        lastActualTailSnapshot = snapshot

        switch source {
        case .initial:
            guard !initialSnapshotInstalled else { return changed }
            initialSnapshotInstalled = true
            requestBottom(source: .initial, animated: false)
        case .poll:
            guard changed,
                  followState == .followingTail,
                  pendingRequest == nil else { return changed }
            requestBottom(source: .poll, animated: false)
        case .restoration, .loadEarlier, .userLatest, .localSend, .reasoning:
            break
        }
        return changed
    }

    @discardableResult
    public mutating func observeTail(
        of thread: CompanionThread,
        source: CompanionScrollRequestSource
    ) -> Bool {
        observeTail(CompanionScrollTailSnapshot(thread: thread), source: source)
    }

    /// Queues a bottom request. A user-latest or initial request explicitly resumes following;
    /// poll callers should only invoke this when already following.
    public mutating func requestBottom(
        source: CompanionScrollRequestSource,
        animated: Bool
    ) {
        if source == .initial || source == .userLatest {
            followState = .followingTail
        }
        enqueue(
            CompanionScrollRequest(
                destination: .bottom,
                source: source,
                animated: animated
            )
        )
    }

    public mutating func requestEntry(
        _ eventID: String,
        source: CompanionScrollRequestSource,
        animated: Bool = false
    ) {
        programmaticBottomScrollOutstanding = false
        if source == .restoration || source == .loadEarlier || source == .reasoning {
            followState = .userReading
        }
        enqueue(
            CompanionScrollRequest(
                destination: .entry(eventID),
                source: source,
                animated: animated
            )
        )
    }

    /// Queues an arbitrary destination for callers which already have a request value.
    public mutating func request(_ request: CompanionScrollRequest) {
        switch request.destination {
        case .bottom:
            if request.source == .initial || request.source == .userLatest {
                followState = .followingTail
            }
        case .entry:
            programmaticBottomScrollOutstanding = false
            if request.source == .restoration
                || request.source == .loadEarlier
                || request.source == .reasoning {
                followState = .userReading
            }
        }
        enqueue(request)
    }

    /// Consumes the one request selected for the current rendered update. Repeated calls without a
    /// new request return nil, so the caller cannot accidentally issue duplicate physical scrolls.
    public mutating func takePendingRequest() -> CompanionScrollRequest? {
        guard let request = pendingRequest else { return nil }
        pendingRequest = nil
        issuedRequestBatchCount += 1
        if request.destination == .bottom {
            // Only geometry observed after the physical request may settle it. Treating a
            // pre-request layout callback as completion reopens the feedback loop while the
            // explicit scroll is still changing the viewport.
            programmaticBottomScrollOutstanding = true
        }
        return request
    }

    /// User interaction always outranks an automatic or still-animating bottom request. SwiftUI's
    /// scroll phase supplies this signal independently from layout geometry, so interrupting an
    /// animation cannot leave the transcript permanently stuck in follow mode.
    @discardableResult
    public mutating func beginUserInteraction(
        bottomDistance: Double,
        threshold: Double
    ) -> Bool {
        if pendingRequest?.destination == .bottom {
            pendingRequest = nil
        }
        programmaticBottomScrollOutstanding = false
        let nextState: CompanionScrollFollowState = bottomDistance <= threshold
            ? .followingTail
            : .userReading
        guard nextState != followState else { return false }
        followState = nextState
        return true
    }

    /// Lets geometry settle a bottom request, or records actual user movement after it settled.
    /// While a bottom request is pending or outstanding, an away-from-bottom geometry callback is
    /// ignored because SwiftUI is still laying out the programmatic scroll.
    @discardableResult
    public mutating func observeGeometry(
        bottomDistance: Double,
        threshold: Double
    ) -> Bool {
        let atBottom = bottomDistance <= threshold
        if pendingRequest?.destination == .bottom {
            return false
        }
        if programmaticBottomScrollOutstanding {
            guard atBottom else { return false }
            programmaticBottomScrollOutstanding = false
            if followState != .followingTail {
                followState = .followingTail
                return true
            }
            return false
        }

        let nextState: CompanionScrollFollowState = atBottom ? .followingTail : .userReading
        guard nextState != followState else { return false }
        followState = nextState
        return true
    }

    public mutating func reset(
        followState: CompanionScrollFollowState = .followingTail
    ) {
        self.followState = followState
        pendingRequest = nil
        issuedRequestBatchCount = 0
        lastActualTailSnapshot = nil
        observedTail = false
        initialSnapshotInstalled = false
        programmaticBottomScrollOutstanding = false
    }

    private mutating func enqueue(_ request: CompanionScrollRequest) {
        guard let existing = pendingRequest else {
            pendingRequest = request
            return
        }

        let candidatePriority = priority(of: request.source)
        let existingPriority = priority(of: existing.source)
        if candidatePriority > existingPriority {
            pendingRequest = request
        } else if candidatePriority == existingPriority,
                  existing.destination == request.destination {
            // A nonanimated request always wins a coalesced batch. This keeps initial, restoration,
            // and poll decisions deterministic even when a later UI callback asks for motion.
            pendingRequest = CompanionScrollRequest(
                destination: existing.destination,
                source: existing.source,
                animated: existing.animated && request.animated
            )
        }
    }

    private func priority(of source: CompanionScrollRequestSource) -> Int {
        switch source {
        case .poll: return 10
        case .initial: return 20
        case .localSend: return 30
        case .reasoning: return 40
        case .loadEarlier: return 50
        case .restoration: return 60
        case .userLatest: return 70
        }
    }
}

/// A client-local snapshot of where one member was reading a Companion transcript.
///
/// This is intentionally presentation state rather than the server's unread watermark. The
/// transcript counts let a restored window keep the saved anchor rendered when messages arrived
/// while the chat was away from the navigation stack.
public struct CompanionChatReadingPosition: Equatable, Sendable {
    public let anchorEventID: String
    public let isFollowingTail: Bool
    public let exposedEntryCount: Int
    public let transcriptEntryCount: Int

    public init(
        anchorEventID: String,
        isFollowingTail: Bool,
        exposedEntryCount: Int,
        transcriptEntryCount: Int
    ) {
        self.anchorEventID = anchorEventID
        self.isFollowingTail = isFollowingTail
        self.exposedEntryCount = max(0, exposedEntryCount)
        self.transcriptEntryCount = max(0, transcriptEntryCount)
    }
}

/// Keeps reading positions isolated by Companion for the lifetime of the native roster.
public struct CompanionChatReadingPositionStore: Equatable, Sendable {
    private var positions: [String: CompanionChatReadingPosition] = [:]

    public init() {}

    public func position(for companionID: String) -> CompanionChatReadingPosition? {
        positions[companionID]
    }

    public mutating func record(
        _ position: CompanionChatReadingPosition,
        for companionID: String
    ) {
        positions[companionID] = position
    }
}

/// Tracks the progressively disclosed portion of a complete thread response.
///
/// The thread endpoint intentionally remains unpaginated. This value keeps the client-side
/// presentation bounded by exposing the newest page first, then adding older entries in fixed
/// pages when the reader asks for them. Refreshing a growing response preserves the number of
/// entries the reader has already exposed.
public struct CompanionTranscriptWindow: Equatable, Sendable {
    public static let defaultPageSize = 50

    public let pageSize: Int
    public private(set) var totalCount: Int
    public private(set) var exposedCount: Int

    public init(
        totalCount: Int = 0,
        pageSize: Int = CompanionTranscriptWindow.defaultPageSize
    ) {
        let pageSize = max(1, pageSize)
        self.pageSize = pageSize
        self.totalCount = 0
        self.exposedCount = 0
        refresh(totalCount: totalCount)
    }

    /// Whether an older page remains hidden from the rendered transcript.
    public var hasEarlierEntries: Bool {
        exposedCount < totalCount
    }

    /// The indexes of the entries exposed by this window for the last refreshed response.
    public var visibleRange: Range<Int> {
        visibleRange(for: totalCount)
    }

    /// The indexes of the entries exposed by this window for a response with `count` entries.
    /// The overload keeps a caller safe while a response is being installed after a refresh.
    public func visibleRange(for count: Int) -> Range<Int> {
        let count = max(0, count)
        let visibleCount = min(exposedCount, count)
        return (count - visibleCount)..<count
    }

    /// Installs the count from a complete thread response.
    ///
    /// A first refresh exposes at most one page. Later refreshes retain the current exposed
    /// count by default. A reader browsing history can instead preserve the entries already on
    /// screen, growing the exposed count by the number of newly appended tail entries.
    public mutating func refresh(
        totalCount: Int,
        preservingCurrentEntries: Bool = false
    ) {
        let count = max(0, totalCount)
        let appendedCount = max(0, count - self.totalCount)
        self.totalCount = count
        if exposedCount == 0 {
            exposedCount = min(pageSize, count)
        } else if preservingCurrentEntries {
            exposedCount = min(count, exposedCount + appendedCount)
        } else {
            exposedCount = min(exposedCount, count)
        }
    }

    /// Restores a previously exposed window and keeps its anchor renderable after tail growth.
    public mutating func restore(
        totalCount: Int,
        previouslyExposedCount: Int,
        previousTotalCount: Int,
        anchorIndex: Int
    ) {
        let count = max(0, totalCount)
        let appendedCount = max(0, count - max(0, previousTotalCount))
        let restoredExposedCount = max(0, previouslyExposedCount) + appendedCount
        let anchorExposedCount = count - min(max(0, anchorIndex), count)
        self.totalCount = count
        exposedCount = min(
            count,
            max(min(pageSize, count), max(restoredExposedCount, anchorExposedCount))
        )
    }

    /// Reveals one older page and returns whether the window changed.
    @discardableResult
    public mutating func loadEarlier() -> Bool {
        guard hasEarlierEntries else { return false }
        let nextCount = min(totalCount, exposedCount + pageSize)
        guard nextCount != exposedCount else { return false }
        exposedCount = nextCount
        return true
    }

    /// Clears the response and disclosure state, such as when navigating to another Companion.
    public mutating func reset() {
        totalCount = 0
        exposedCount = 0
    }
}

/// Serializes durable writes whose response replaces the whole thread while still deduplicating the
/// caller's stable mutation id. Distinct decision and turn-cancellation requests must not overlap
/// and let an older snapshot replace a newer accepted mutation. A failed write releases its id so
/// the same action can retry.
public actor CompanionThreadMutationGate {
    private var activeMutationIDs: Set<String> = []
    private var writeInProgress = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init() {}

    public func acquire(mutationID: String) async -> Bool {
        guard activeMutationIDs.insert(mutationID).inserted else { return false }

        if writeInProgress {
            await withCheckedContinuation { continuation in
                waiters.append(continuation)
            }
        } else {
            writeInProgress = true
        }

        return true
    }

    public func release(mutationID: String) {
        guard activeMutationIDs.remove(mutationID) != nil else { return }

        if waiters.isEmpty {
            writeInProgress = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}
