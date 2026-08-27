public struct CompanionRosterState: Sendable {
    private struct OptimisticRemoval: Sendable {
        let companion: CompanionSummary
        let index: Int
    }

    public private(set) var companions: [CompanionSummary]
    private var optimisticRemovals: [String: OptimisticRemoval] = [:]

    public init(companions: [CompanionSummary] = []) {
        self.companions = companions
    }

    public var sections: CompanionRosterSections {
        CompanionRosterSections(
            pinned: companions.filter { $0.pinned && !$0.hidden },
            unpinned: companions.filter { !$0.pinned && !$0.hidden },
            hidden: companions.filter(\.hidden)
        )
    }

    public mutating func reconcile(with companions: [CompanionSummary]) {
        self.companions = companions
        let serverIDs = Set(companions.map(\.id))
        optimisticRemovals = optimisticRemovals.filter { serverIDs.contains($0.key) }
    }

    public mutating func prepend(_ companion: CompanionSummary) {
        optimisticRemovals[companion.id] = nil
        companions.removeAll { $0.id == companion.id }
        let insertionIndex = companion.pinned
            ? companions.firstIndex(where: { !$0.pinned || $0.hidden }) ?? companions.endIndex
            : companions.firstIndex(where: \.hidden) ?? companions.endIndex
        companions.insert(companion, at: insertionIndex)
    }

    @discardableResult
    public mutating func replace(_ companion: CompanionSummary) -> Bool {
        guard let index = companions.firstIndex(where: { $0.id == companion.id }) else { return false }
        companions[index] = companion.preservingListProjection(from: companions[index])
        return true
    }

    /// Member-state responses do not carry the server's pin timestamp. Keep each group's relative
    /// order stable here, then let the next list poll restore authoritative pin-age/recency order.
    @discardableResult
    public mutating func replaceAndRepartition(_ companion: CompanionSummary) -> Bool {
        guard let index = companions.firstIndex(where: { $0.id == companion.id }) else { return false }
        let previous = companions[index]
        let merged = companion.preservingListProjection(from: previous)
        guard previous.pinned != merged.pinned || previous.hidden != merged.hidden else {
            companions[index] = merged
            return true
        }
        companions.remove(at: index)
        if merged.hidden {
            companions.append(merged)
        } else if merged.pinned {
            let insertionIndex = companions.firstIndex(where: { !$0.pinned || $0.hidden }) ?? companions.endIndex
            companions.insert(merged, at: insertionIndex)
        } else {
            let insertionIndex = companions.firstIndex(where: \.hidden) ?? companions.endIndex
            companions.insert(merged, at: insertionIndex)
        }
        return true
    }

    @discardableResult
    public mutating func removeOptimistically(companionID: String) -> CompanionSummary? {
        guard optimisticRemovals[companionID] == nil,
              let index = companions.firstIndex(where: { $0.id == companionID }) else { return nil }
        let companion = companions.remove(at: index)
        optimisticRemovals[companionID] = OptimisticRemoval(companion: companion, index: index)
        return companion
    }

    public mutating func acceptDeletion(companionID: String) {
        optimisticRemovals[companionID] = nil
    }

    @discardableResult
    public mutating func reconcileDeletionResponse(
        companionID: String,
        operation: CompanionOperationSummary
    ) -> CompanionSummary? {
        guard !operation.isActive else {
            acceptDeletion(companionID: companionID)
            return nil
        }
        return restoreDeletion(companionID: companionID)
    }

    public func contains(companionID: String) -> Bool {
        companions.contains { $0.id == companionID }
    }

    @discardableResult
    public mutating func restoreDeletion(companionID: String) -> CompanionSummary? {
        guard let removal = optimisticRemovals.removeValue(forKey: companionID) else { return nil }
        guard !companions.contains(where: { $0.id == companionID }) else { return nil }
        companions.insert(removal.companion, at: min(removal.index, companions.endIndex))
        return removal.companion
    }
}

public struct CompanionRosterSections: Equatable, Sendable {
    public let pinned: [CompanionSummary]
    public let unpinned: [CompanionSummary]
    public let hidden: [CompanionSummary]

    public init(
        pinned: [CompanionSummary],
        unpinned: [CompanionSummary],
        hidden: [CompanionSummary]
    ) {
        self.pinned = pinned
        self.unpinned = unpinned
        self.hidden = hidden
    }
}
