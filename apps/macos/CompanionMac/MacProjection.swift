import Foundation
import CompanionKit

/// The stable, presentation-only grouping used by the macOS roster.
///
/// The server owns member-private ordering. This type intentionally preserves the incoming
/// order and only removes rows that do not match the reader's search. Hidden rows are returned in
/// the projection even when the disclosure is collapsed so a UI can expose an honest count.
public struct CompanionMacRosterProjection: Equatable, Sendable {
    public struct Sections: Equatable, Sendable {
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

        public var visibleCompanions: [CompanionSummary] {
            pinned + unpinned + hidden
        }
    }

    public let query: String
    public let sections: Sections
    public let hiddenExpanded: Bool

    public init(
        companions: [CompanionSummary],
        query: String = "",
        hiddenExpanded: Bool = false
    ) {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        self.query = normalizedQuery
        self.hiddenExpanded = hiddenExpanded

        let matching = companions.filter { companion in
            guard !normalizedQuery.isEmpty else { return true }
            return Self.searchText(for: companion).localizedCaseInsensitiveContains(normalizedQuery)
        }
        sections = Sections(
            pinned: matching.filter { $0.pinned && !$0.hidden },
            unpinned: matching.filter { !$0.pinned && !$0.hidden },
            hidden: matching.filter(\.hidden)
        )
    }

    public var visibleSections: Sections {
        Sections(
            pinned: sections.pinned,
            unpinned: sections.unpinned,
            hidden: hiddenExpanded || !query.isEmpty ? sections.hidden : []
        )
    }

    public var visibleCompanions: [CompanionSummary] {
        visibleSections.visibleCompanions
    }

    public var totalMatchCount: Int {
        sections.pinned.count + sections.unpinned.count + sections.hidden.count
    }

    public func contains(_ companionID: String) -> Bool {
        visibleCompanions.contains { $0.id == companionID }
    }

    private static func searchText(for companion: CompanionSummary) -> String {
        [companion.name, companion.persona ?? "", companion.lastMessage?.preview ?? ""]
            .joined(separator: "\n")
    }
}
/// The macOS client must not offer a desktop handoff to a Viewer or to a Box that is not already
/// running. Keeping that decision in a pure projection makes it testable without UI hosting or a
/// network session and gives toolbar/menu surfaces one source of truth.
public enum CompanionMacDesktopEligibility: Equatable, Sendable {
    case allowed
    case viewerReadOnly
    case boxNotRunning

    public static func evaluate(
        access: CompanionAccess,
        runtimeState: CompanionRuntimeState
    ) -> Self {
        guard access.canEditCompanionSettings else { return .viewerReadOnly }
        return runtimeState == .running ? .allowed : .boxNotRunning
    }

    public var canOpen: Bool {
        self == .allowed
    }

    public var explanation: String {
        switch self {
        case .allowed:
            return "Open the Box desktop"
        case .viewerReadOnly:
            return "Viewers cannot open the Box desktop"
        case .boxNotRunning:
            return "The Box desktop is available while the Box is running"
        }
    }
}

/// Ephemeral state for the dedicated desktop window. It deliberately has no Codable or
/// persistence surface: desktop URLs are signed, short-lived credentials and must disappear with
/// the window or when a new handoff replaces them.
public enum CompanionMacDesktopPhase: Equatable, Sendable {
    case empty
    case requesting
    case provisioning
    case loaded
    case failed
}
