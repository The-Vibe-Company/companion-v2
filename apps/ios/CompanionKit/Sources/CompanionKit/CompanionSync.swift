import Foundation

public struct CompanionSyncMeasurement<Value: Sendable>: Sendable {
    public let value: Value
    public let receivedBytes: Int
    public let networkMilliseconds: Double

    public init(value: Value, receivedBytes: Int, networkMilliseconds: Double) {
        self.value = value
        self.receivedBytes = receivedBytes
        self.networkMilliseconds = networkMilliseconds
    }
}

public struct CompanionRosterDelta: Codable, Equatable, Sendable {
    public let cursor: String
    public let changedCompanions: [CompanionSummary]
    public let deletedCompanionIDs: [String]
    public let companionIDs: [String]
    public let changedSections: [CompanionSection]
    public let deletedSectionIDs: [String]
    public let sectionIDs: [String]

    enum CodingKeys: String, CodingKey {
        case cursor
        case changedCompanions = "changed_companions"
        case deletedCompanionIDs = "deleted_companion_ids"
        case companionIDs = "companion_ids"
        case changedSections = "changed_sections"
        case deletedSectionIDs = "deleted_section_ids"
        case sectionIDs = "section_ids"
    }

    public func applying(to snapshot: CompanionRosterSnapshot?) throws -> CompanionRosterSnapshot {
        var companions = Dictionary(uniqueKeysWithValues: (snapshot?.companions ?? []).map { ($0.id, $0) })
        deletedCompanionIDs.forEach { companions[$0] = nil }
        changedCompanions.forEach { companions[$0.id] = $0 }
        guard companionIDs.count == companions.count,
              Set(companionIDs).count == companionIDs.count,
              companionIDs.allSatisfy({ companions[$0] != nil }) else {
            throw CompanionSyncMergeError.incompleteRoster
        }

        var sections = Dictionary(uniqueKeysWithValues: (snapshot?.sections ?? []).map { ($0.id, $0) })
        deletedSectionIDs.forEach { sections[$0] = nil }
        changedSections.forEach { sections[$0.id] = $0 }
        guard sectionIDs.count == sections.count,
              Set(sectionIDs).count == sectionIDs.count,
              sectionIDs.allSatisfy({ sections[$0] != nil }) else {
            throw CompanionSyncMergeError.incompleteRoster
        }

        return CompanionRosterSnapshot(
            cursor: cursor,
            companions: companionIDs.compactMap { companions[$0] },
            sections: sectionIDs.compactMap { sections[$0] }
        )
    }
}

public struct CompanionThreadMetadata: Codable, Equatable, Sendable {
    public let companionID: String
    public let viewerID: String
    public let readOnly: Bool
    public let canSend: Bool
    public let transcriptionAvailable: Bool?
    public let activeTurn: CompanionTurn?
    public let queuedCount: Int
    public let interruptedTurn: CompanionTurn?

    enum CodingKeys: String, CodingKey {
        case companionID = "companion_id"
        case viewerID = "viewer_id"
        case readOnly = "read_only"
        case canSend = "can_send"
        case transcriptionAvailable = "transcription_available"
        case activeTurn = "active_turn"
        case queuedCount = "queued_count"
        case interruptedTurn = "interrupted_turn"
    }

    func thread(entries: [TranscriptEntry]) -> CompanionThread {
        CompanionThread(
            companionID: companionID,
            viewerID: viewerID,
            readOnly: readOnly,
            canSend: canSend,
            transcriptionAvailable: transcriptionAvailable,
            entries: entries,
            activeTurn: activeTurn,
            queuedCount: queuedCount,
            interruptedTurn: interruptedTurn
        )
    }
}

public struct CompanionThreadDelta: Codable, Equatable, Sendable {
    public let cursor: String
    public let changedEntries: [TranscriptEntry]
    public let deletedEventIDs: [String]
    public let thread: CompanionThreadMetadata

    enum CodingKeys: String, CodingKey {
        case cursor
        case changedEntries = "changed_entries"
        case deletedEventIDs = "deleted_event_ids"
        case thread
    }

    public func applying(to snapshot: CompanionThreadSnapshot?) -> CompanionThreadSnapshot {
        var entries = Dictionary(
            uniqueKeysWithValues: (snapshot?.thread.entries ?? []).map { ($0.eventID, $0) }
        )
        deletedEventIDs.forEach { entries[$0] = nil }
        changedEntries.forEach { entries[$0.eventID] = $0 }
        let ordered = entries.values.sorted {
            $0.ordinal == $1.ordinal ? $0.eventID < $1.eventID : $0.ordinal < $1.ordinal
        }
        return CompanionThreadSnapshot.bounded(
            cursor: cursor,
            thread: thread.thread(entries: ordered)
        )
    }
}

public enum CompanionSyncMergeError: Error, Equatable {
    case incompleteRoster
}

func companionMilliseconds(from duration: Duration) -> Double {
    let parts = duration.components
    return (Double(parts.seconds) * 1_000)
        + (Double(parts.attoseconds) / 1_000_000_000_000_000)
}
