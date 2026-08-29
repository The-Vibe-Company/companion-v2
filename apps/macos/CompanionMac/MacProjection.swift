import CompanionKit
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
