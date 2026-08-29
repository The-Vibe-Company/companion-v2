import Foundation
import OSLog
import QuartzCore

@MainActor
enum CompanionPerformanceTelemetry {
    private static let launchStartedAt = ContinuousClock.now
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "dev.companion.mobile",
        category: "LaunchPerformance"
    )
    private static let signpost = OSLog(
        subsystem: Bundle.main.bundleIdentifier ?? "dev.companion.mobile",
        category: "LaunchPerformance"
    )
    private static var recordedRosterFrame = false
    private static var pendingChatTaps: [String: ContinuousClock.Instant] = [:]

    static func rosterWillRender(cacheRestoreMilliseconds: Double?, companionCount: Int) {
        guard !recordedRosterFrame else { return }
        recordedRosterFrame = true
        OneShotDisplayFrame.perform {
            let milliseconds = launchStartedAt.duration(to: .now).companionMilliseconds
            logger.info(
                "cold_launch_first_roster_frame_ms=\(milliseconds, format: .fixed(precision: 2), privacy: .public) cache_restore_ms=\(cacheRestoreMilliseconds ?? -1, format: .fixed(precision: 2), privacy: .public) companions=\(companionCount, privacy: .public)"
            )
            os_signpost(
                .event,
                log: signpost,
                name: "Cold launch to roster frame",
                "milliseconds=%{public}.2f companions=%{public}d",
                milliseconds,
                companionCount
            )
        }
    }

    static func chatTapped(companionID: String) {
        pendingChatTaps[companionID] = .now
    }

    static func transcriptWillRender(companionID: String, entryCount: Int, cached: Bool) {
        guard let startedAt = pendingChatTaps.removeValue(forKey: companionID) else { return }
        OneShotDisplayFrame.perform {
            let milliseconds = startedAt.duration(to: .now).companionMilliseconds
            logger.info(
                "tap_to_chat_first_transcript_frame_ms=\(milliseconds, format: .fixed(precision: 2), privacy: .public) cached=\(cached, privacy: .public) entries=\(entryCount, privacy: .public)"
            )
            os_signpost(
                .event,
                log: signpost,
                name: "Tap to transcript frame",
                "milliseconds=%{public}.2f cached=%{public}d entries=%{public}d",
                milliseconds,
                cached ? 1 : 0,
                entryCount
            )
        }
    }

    static func syncCompleted(surface: String, bytes: Int, milliseconds: Double) {
        logger.info(
            "incremental_sync surface=\(surface, privacy: .public) bytes=\(bytes, privacy: .public) milliseconds=\(milliseconds, format: .fixed(precision: 2), privacy: .public)"
        )
        os_signpost(
            .event,
            log: signpost,
            name: "Incremental sync",
            "surface=%{public}@ bytes=%{public}d milliseconds=%{public}.2f",
            surface as NSString,
            bytes,
            milliseconds
        )
    }
}

private final class OneShotDisplayFrame: NSObject {
    private var displayLink: CADisplayLink?
    private let action: @MainActor () -> Void

    private init(action: @escaping @MainActor () -> Void) {
        self.action = action
        super.init()
        let displayLink = CADisplayLink(target: self, selector: #selector(fired))
        self.displayLink = displayLink
        displayLink.add(to: .main, forMode: .common)
    }

    @MainActor
    static func perform(_ action: @escaping @MainActor () -> Void) {
        _ = OneShotDisplayFrame(action: action)
    }

    @MainActor @objc private func fired() {
        displayLink?.invalidate()
        displayLink = nil
        action()
    }
}

private extension Duration {
    var companionMilliseconds: Double {
        let parts = components
        return (Double(parts.seconds) * 1_000) + (Double(parts.attoseconds) / 1_000_000_000_000_000)
    }
}
