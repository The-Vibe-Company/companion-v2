import Foundation

/// Stable, platform-neutral chat geometry shared by the SwiftUI transcript and its unit tests.
/// Values are expressed in points so the app can apply them without moving SwiftUI into
/// CompanionKit.
public enum CompanionChatBubbleKind: Equatable, Sendable {
    case assistant
    case member
    case mine
    case card
    case tool
}

public enum CompanionChatBubbleAlignment: Equatable, Sendable {
    case leading
    case trailing
}

public enum CompanionChatBubbleLayout {
    public static let maximumWidthFraction = 0.8
    public static let absoluteMaximumWidth = 680.0
    public static let consecutiveAssistantSpacing = 8.0
    public static let standardSpacing = 16.0

    public static func alignment(for kind: CompanionChatBubbleKind) -> CompanionChatBubbleAlignment {
        kind == .mine ? .trailing : .leading
    }

    public static func maximumWidth(in availableWidth: Double) -> Double {
        max(0, min(availableWidth * maximumWidthFraction, absoluteMaximumWidth))
    }

    public static func spacing(
        after previous: CompanionChatBubbleKind?,
        before current: CompanionChatBubbleKind
    ) -> Double {
        guard let previous else { return 0 }
        return previous == .assistant && current == .assistant
            ? consecutiveAssistantSpacing
            : standardSpacing
    }
}

public enum CompanionDecisionCardOutcome: Equatable, Sendable {
    case allowed
    case denied
    case answered(String)
    case expired
    case cancelled
    case unknown

    public var bubbleText: String {
        switch self {
        case .allowed: "Approved"
        case .denied: "Denied"
        case .answered(let answer): answer.isEmpty ? "Answered" : answer
        case .expired: "Timed out, denied"
        case .cancelled: "Closed without approval"
        case .unknown: "Request status unknown"
        }
    }
}

/// A deterministic projection of the durable decision state into the card controls. The source
/// status remains authoritative: an expired or otherwise settled request can never become
/// interactive because of stale local input.
public struct CompanionDecisionCardProjection: Equatable, Sendable {
    public let isCollapsed: Bool
    public let showsActions: Bool
    public let isInteractive: Bool
    public let primaryActionTitle: String?
    public let secondaryActionTitle: String?
    public let primaryActionDisabled: Bool
    public let waitingMessage: String?
    public let outcome: CompanionDecisionCardOutcome?

    public init(
        decision: CompanionDecision,
        canAct: Bool,
        busy: Bool,
        answer: String
    ) {
        let pending = decision.status == .pending
        isCollapsed = !pending
        showsActions = pending && canAct && decision.kind != .unknown
        isInteractive = showsActions && !busy

        if showsActions {
            primaryActionTitle = decision.kind == .question ? "Answer" : "Approve"
            secondaryActionTitle = "Deny"
        } else {
            primaryActionTitle = nil
            secondaryActionTitle = nil
        }

        primaryActionDisabled = decision.kind == .question
            && answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        if pending && !canAct {
            waitingMessage = "Waiting for an Owner or Editor"
        } else if pending && decision.kind == .unknown {
            waitingMessage = "Update Companion to respond to this request."
        } else {
            waitingMessage = nil
        }

        switch decision.status {
        case .pending:
            outcome = nil
        case .allowed:
            outcome = .allowed
        case .denied:
            outcome = .denied
        case .answered:
            outcome = .answered(decision.answer ?? "")
        case .expired:
            outcome = .expired
        case .cancelled:
            outcome = .cancelled
        case .unknown:
            outcome = .unknown
        }
    }
}
