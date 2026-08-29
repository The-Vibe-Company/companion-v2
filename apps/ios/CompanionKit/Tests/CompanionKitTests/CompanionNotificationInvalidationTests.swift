import Foundation
import Testing
@testable import CompanionKit

@Suite("Companion notification invalidation")
@MainActor
struct CompanionNotificationInvalidationTests {
    @Test("a notification invalidation survives session-store binding")
    func invalidationBeforeSessionBindingReplays() {
        let queue = CompanionNotificationInvalidationQueue()
        let recorder = InvalidationRecorder()

        queue.invalidate(scopeID: "org-a", companionID: "companion-tap")
        #expect(recorder.companionIDs.isEmpty)

        queue.install(scopeID: "org-a") { recorder.record($0) }

        #expect(recorder.companionIDs == ["companion-tap"])
    }

    @Test("foreground delivery invalidates an already-open chat immediately")
    func foregroundDeliveryUsesInstalledHandler() {
        let queue = CompanionNotificationInvalidationQueue()
        let recorder = InvalidationRecorder()
        queue.install(scopeID: "org-a") { recorder.record($0) }

        queue.invalidate(scopeID: "org-a", companionID: "companion-open")

        #expect(recorder.companionIDs == ["companion-open"])
    }

    @Test("pre-restore deliveries coalesce per Companion")
    func pendingInvalidationsCoalesceWithoutLosingCompanions() {
        let queue = CompanionNotificationInvalidationQueue()
        let recorder = InvalidationRecorder()
        queue.invalidate(scopeID: "org-a", companionID: "companion-a")
        queue.invalidate(scopeID: "org-a", companionID: "companion-a")
        queue.invalidate(scopeID: "org-a", companionID: "companion-b")

        queue.install(scopeID: "org-a") { recorder.record($0) }

        #expect(recorder.companionIDs == ["companion-a", "companion-b"])
    }

    @Test("an initial chat sync subsumes a retained notification without losing later invalidations")
    func initialChatSyncConsumesOnlyTheRetainedInvalidation() async {
        let store = SessionStore(
            apiURL: URL(string: "https://offline.invalid")!,
            storage: EmptySessionStorage()
        )
        let companionID = "companion-tap"
        store.invalidateCompanion(companionID: companionID)

        let invalidations = store.companionInvalidations(
            companionID: companionID,
            replayPending: false
        )
        let recorder = StreamInvalidationRecorder()
        let consumer = Task { @MainActor in
            for await _ in invalidations {
                recorder.record()
                return
            }
        }

        for _ in 0..<5 { await Task.yield() }
        #expect(recorder.count == 0)

        store.invalidateCompanion(companionID: companionID)
        for _ in 0..<20 where recorder.count == 0 { await Task.yield() }
        #expect(recorder.count == 1)
        consumer.cancel()
    }

    @Test("background delivery awaits the installed delta refresh")
    func backgroundDeliveryReturnsTheRefreshOutcome() async {
        let queue = CompanionNotificationInvalidationQueue()
        let recorder = InvalidationRecorder()
        queue.install(
            scopeID: "org-a",
            { recorder.record($0) },
            backgroundRefresh: { companionID in
                recorder.record(companionID)
                return .newData
            }
        )

        let result = await queue.refresh(scopeID: "org-a", companionID: "companion-background")

        #expect(result == .newData)
        #expect(recorder.companionIDs == ["companion-background"])
    }

    @Test("a timed-out cold delivery reports failure but retains its invalidation")
    func timedOutBackgroundDeliveryRetainsInvalidation() async {
        let queue = CompanionNotificationInvalidationQueue()
        let recorder = InvalidationRecorder()

        let result = await queue.refresh(scopeID: "org-a", companionID: "companion-signed-out")

        #expect(result == .failed)

        queue.install(
            scopeID: "org-a",
            { _ in },
            backgroundRefresh: { companionID in
                recorder.record(companionID)
                return .newData
            }
        )
        for _ in 0..<20 where recorder.companionIDs.isEmpty {
            await Task.yield()
        }
        #expect(recorder.companionIDs == ["companion-signed-out"])
    }

    @Test("cold background delivery waits for active-session binding")
    func coldBackgroundDeliverySurvivesTheBindingRace() async {
        let queue = CompanionNotificationInvalidationQueue()
        let refresh = Task {
            await queue.refresh(scopeID: "org-a", companionID: "companion-cold")
        }
        await Task.yield()

        queue.install(
            scopeID: "org-a",
            { _ in },
            backgroundRefresh: { _ in .noData }
        )

        #expect(await refresh.value == .noData)
    }

    @Test("a notification for another organization cannot reach the active session")
    func mismatchedOrganizationFailsClosed() async {
        let queue = CompanionNotificationInvalidationQueue()
        let recorder = InvalidationRecorder()
        queue.install(
            scopeID: "org-a",
            { recorder.record($0) },
            backgroundRefresh: { _ in .newData }
        )

        queue.invalidate(scopeID: "org-b", companionID: "companion-b")
        let result = await queue.refresh(scopeID: "org-b", companionID: "companion-b")

        #expect(recorder.companionIDs.isEmpty)
        #expect(result == .failed)
    }

    @Test("uninstall drops closures and pending work from the signed-out session")
    func uninstallDropsSessionWork() {
        let queue = CompanionNotificationInvalidationQueue()
        let recorder = InvalidationRecorder()
        queue.invalidate(scopeID: "org-a", companionID: "companion-a")

        queue.uninstall()
        queue.install(scopeID: "org-a") { recorder.record($0) }

        #expect(recorder.companionIDs.isEmpty)
    }

    @Test("queued background work is not replayed through the foreground handler")
    func backgroundWorkUsesBackgroundHandler() async {
        let queue = CompanionNotificationInvalidationQueue()
        let recorder = InvalidationRecorder()
        _ = await queue.refresh(scopeID: "org-a", companionID: "companion-background")

        queue.install(
            scopeID: "org-a",
            { _ in recorder.record("foreground") },
            backgroundRefresh: { companionID in
                recorder.record("background:\(companionID)")
                return .noData
            }
        )
        for _ in 0..<20 where recorder.companionIDs.isEmpty {
            await Task.yield()
        }

        #expect(recorder.companionIDs == ["background:companion-background"])
    }
}

@MainActor
private final class InvalidationRecorder {
    private(set) var companionIDs: [String] = []

    func record(_ companionID: String) {
        companionIDs.append(companionID)
    }
}

private struct EmptySessionStorage: SessionStorage {
    func load() throws -> Data? { nil }
    func save(_ data: Data) throws {}
    func remove() throws {}
}

@MainActor
private final class StreamInvalidationRecorder {
    private(set) var count = 0

    func record() {
        count += 1
    }
}
