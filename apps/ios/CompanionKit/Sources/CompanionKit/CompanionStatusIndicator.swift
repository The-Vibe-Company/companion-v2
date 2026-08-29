public enum CompanionStatusIndicatorTint: Equatable, Sendable {
    case live
    case inactive
    case error
}

/// The compact, presentation-safe activity state shared by native Companion surfaces.
///
/// The server projection has already folded Box and daemon lifecycle details into `runtime.state`.
/// In particular, archived Boxes arrive as `stopped`, while `replying` is true only after Pi has
/// acknowledged the active attempt.
public enum CompanionStatusIndicatorState: String, Equatable, Sendable {
    case inactive
    case live
    case replying
    case error

    public init(runtimeState: CompanionRuntimeState, isReplying: Bool) {
        if isReplying {
            self = .replying
            return
        }

        switch runtimeState {
        case .running:
            self = .live
        case .error:
            self = .error
        case .notCreated, .provisioning, .stopping, .stopped, .unknown:
            self = .inactive
        }
    }

    public init(runtime: CompanionSummary.Runtime) {
        self.init(runtimeState: runtime.state, isReplying: runtime.replying)
    }

    public var tint: CompanionStatusIndicatorTint {
        switch self {
        case .live, .replying: return .live
        case .inactive: return .inactive
        case .error: return .error
        }
    }

    public var accessibilityLabel: String {
        switch self {
        case .inactive: return "Stopped"
        case .live: return "Live"
        case .replying: return "Replying"
        case .error: return "Error"
        }
    }

    public func shouldPulse(reduceMotion: Bool) -> Bool {
        self == .replying && !reduceMotion
    }
}
