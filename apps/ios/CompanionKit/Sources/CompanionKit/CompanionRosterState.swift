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

    public mutating func reconcile(with companions: [CompanionSummary]) {
        self.companions = companions
        let serverIDs = Set(companions.map(\.id))
        optimisticRemovals = optimisticRemovals.filter { serverIDs.contains($0.key) }
    }

    public mutating func prepend(_ companion: CompanionSummary) {
        optimisticRemovals[companion.id] = nil
        companions.removeAll { $0.id == companion.id }
        companions.insert(companion, at: 0)
    }

    @discardableResult
    public mutating func replace(_ companion: CompanionSummary) -> Bool {
        guard let index = companions.firstIndex(where: { $0.id == companion.id }) else { return false }
        companions[index] = companion.preservingListProjection(from: companions[index])
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
