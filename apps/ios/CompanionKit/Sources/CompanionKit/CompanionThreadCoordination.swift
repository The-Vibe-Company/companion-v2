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
}

/// Serializes durable decision writes for one Companion while still deduplicating by Pi request id.
/// Each endpoint response contains the whole thread, so distinct requests must not overlap and let
/// an older snapshot replace a newer accepted decision. Finishing a failed write releases the id so
/// the same card can retry.
public actor CompanionDecisionSubmissionGate {
    private var activeRequestIDs: Set<String> = []
    private var writeInProgress = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init() {}

    public func acquire(requestID: String) async -> Bool {
        guard activeRequestIDs.insert(requestID).inserted else { return false }

        if writeInProgress {
            await withCheckedContinuation { continuation in
                waiters.append(continuation)
            }
        } else {
            writeInProgress = true
        }

        return true
    }

    public func release(requestID: String) {
        guard activeRequestIDs.remove(requestID) != nil else { return }

        if waiters.isEmpty {
            writeInProgress = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}
