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
