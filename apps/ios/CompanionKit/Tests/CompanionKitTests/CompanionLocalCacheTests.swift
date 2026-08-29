import Foundation
import Testing
@testable import CompanionKit

private struct FixedSessionStorage: SessionStorage {
    let data: Data?
    func load() throws -> Data? { data }
    func save(_ data: Data) throws {}
    func remove() throws {}
}

private final class SuspendedThreadSyncURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var releaseResponse = DispatchSemaphore(value: 0)
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requestDidStart = false
    private nonisolated(unsafe) static var requestedURL: URL?

    static func reset() {
        lock.lock()
        requestDidStart = false
        requestedURL = nil
        lock.unlock()
        releaseResponse = DispatchSemaphore(value: 0)
    }

    static var hasStarted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return requestDidStart
    }

    static var capturedURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return requestedURL
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requestedURL = request.url
        Self.requestDidStart = true
        Self.lock.unlock()
        _ = Self.releaseResponse.wait(timeout: .now() + 5)
        let payload = #"""
        {
          "cursor":"next-cursor",
          "reset_entries":false,
          "changed_entries":[],
          "deleted_event_ids":[],
          "thread":{
            "companion_id":"22222222-2222-4222-8222-222222222222",
            "viewer_id":"user-1",
            "read_only":false,
            "can_send":true,
            "transcription_available":true,
            "active_turn":null,
            "queued_count":0,
            "interrupted_turn":null
          }
        }
        """#
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class BackgroundRefreshURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requestCount = 0

    static func reset() {
        lock.lock()
        requestCount = 0
        lock.unlock()
    }

    static var requestsStarted: Int {
        lock.lock()
        defer { lock.unlock() }
        return requestCount
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requestCount += 1
        Self.lock.unlock()
        let path = request.url?.path ?? ""
        let payload: String
        if path == "/v1/companions/sync" {
            payload = #"""
            {
              "cursor":"fresh-roster","changed_companions":[
                {
                  "id":"33333333-3333-4333-8333-333333333333","name":"Background",
                  "persona":"Help","model_id":"model","selected_skill_ids":[],
                  "selected_mcp_account_ids":[],"icon":null,"section_id":null,"access":"owner",
                  "pinned":false,"hidden":false,"muted":false,"unread":false,"last_message":null,
                  "runtime":{"state":"running","daemon_state":"running","replying":false,
                    "last_error":null,"provider_ids":[],"latest_operation":null}
                }
              ],"deleted_companion_ids":[],
              "companion_ids":["33333333-3333-4333-8333-333333333333"],
              "changed_sections":[],"deleted_section_ids":[],"section_ids":[]
            }
            """#
        } else {
            payload = #"""
            {
              "cursor":"fresh-thread","reset_entries":true,
              "changed_entries":[],"deleted_event_ids":[],
              "thread":{
                "companion_id":"33333333-3333-4333-8333-333333333333","viewer_id":"user-1",
                "read_only":false,"can_send":true,"transcription_available":true,
                "active_turn":null,"queued_count":0,"interrupted_turn":null
              }
            }
            """#
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test
func sqliteCachePersistsRestoresScopesAndBoundedThreadTail() throws {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try SQLiteCompanionSnapshotCache(
        url: directory.appending(path: "cache.sqlite3", directoryHint: .notDirectory)
    )
    let roster = CompanionRosterSnapshot(
        cursor: "roster-cursor",
        companions: [try companionSummary()],
        sections: [],
        syncedAt: Date(timeIntervalSince1970: 1_777_680_000)
    )
    try cache.saveRoster(roster, scope: "org-a:user-a")
    #expect(try cache.roster(scope: "org-a:user-a") == roster)
    #expect(try cache.roster(scope: "org-a:user-b") == nil)

    let entries = try (0..<300).map { try transcriptEntry(ordinal: $0) }
    let snapshot = CompanionThreadSnapshot(
        cursor: "thread-cursor",
        thread: try companionThread(entries: entries)
    )
    #expect(snapshot.thread.entries.count == 300)
    try cache.saveThread(snapshot, scope: "org-a:user-a", companionID: snapshot.thread.companionID)
    let restoredSnapshot = try cache.thread(
        scope: "org-a:user-a",
        companionID: snapshot.thread.companionID
    )
    let restored = try #require(restoredSnapshot)
    #expect(restored.isPartial)
    #expect(restored.thread.entries.count == 250)
    #expect(restored.thread.entries.first?.ordinal == 50)
}

@Test
func threadDeltaKeepsFullLiveHistoryAndResetsExceptionalHistory() throws {
    let entries = try (0..<300).map { try transcriptEntry(ordinal: $0) }
    let thread = try companionThread(entries: [])
    let delta = CompanionThreadDelta(
        cursor: "full-cursor",
        resetEntries: true,
        changedEntries: entries,
        deletedEventIDs: [],
        thread: CompanionThreadMetadata(
            companionID: thread.companionID,
            viewerID: thread.viewerID,
            readOnly: thread.readOnly,
            canSend: thread.canSend,
            transcriptionAvailable: thread.transcriptionAvailable,
            activeTurn: thread.activeTurn,
            queuedCount: thread.queuedCount,
            interruptedTurn: thread.interruptedTurn
        )
    )

    let live = delta.applying(to: CompanionThreadSnapshot(
        cursor: "stale-cursor",
        thread: try companionThread(entries: [try transcriptEntry(ordinal: 999)])
    ))
    #expect(live.thread.entries.count == 300)
    #expect(live.thread.entries.first?.ordinal == 0)
    #expect(live.thread.entries.last?.ordinal == 299)
}

@Test @MainActor
func offlineSessionRestoresRosterWithoutWaitingForNetwork() throws {
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let snapshot = CompanionRosterSnapshot(
        cursor: "roster-cursor",
        companions: [try companionSummary()],
        sections: [],
        syncedAt: Date(timeIntervalSince1970: 1_777_680_000)
    )
    try fixture.cache.saveRoster(snapshot, scope: "org-1:user-1")

    let store = SessionStore(
        apiURL: URL(string: "https://offline.invalid")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: fixture.cache
    )

    #expect(store.phase == .active(session))
    let restored = try #require(store.initialRosterSnapshot)
    #expect(restored.schemaVersion == snapshot.schemaVersion)
    #expect(restored.cursor == snapshot.cursor)
    #expect(restored.companions == snapshot.companions)
    #expect(restored.sections == snapshot.sections)
    #expect((store.initialCacheRestoreMilliseconds ?? .infinity) < 50)
}

@Test @MainActor
func cachedThreadRemainsRenderableWhileDeltaSynchronizationIsInFlight() async throws {
    SuspendedThreadSyncURLProtocol.reset()
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let cached = CompanionThreadSnapshot(
        cursor: "prior-cursor",
        thread: try companionThread(entries: try (0..<300).map {
            try transcriptEntry(ordinal: $0)
        })
    )
    try fixture.cache.saveThread(
        cached,
        scope: "org-1:user-1",
        companionID: cached.thread.companionID
    )

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SuspendedThreadSyncURLProtocol.self]
    let client = APIClient(
        baseURL: URL(string: "https://example.test")!,
        session: URLSession(configuration: configuration),
        initialAuthority: session
    )
    let store = SessionStore(
        apiURL: URL(string: "https://example.test")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: fixture.cache,
        apiClient: client
    )
    let rendered = try #require(store.cachedThread(companionID: cached.thread.companionID))
    let projection = CompanionThreadProjection(thread: rendered.thread)
    #expect(!projection.needsBlockingLoader)
    #expect(rendered.thread.readOnly)
    #expect(!rendered.thread.canSend)

    let synchronization = Task {
        try await store.synchronizeThread(companionID: cached.thread.companionID)
    }
    for _ in 0..<500 where !SuspendedThreadSyncURLProtocol.hasStarted {
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(SuspendedThreadSyncURLProtocol.hasStarted)

    // The request has reached the transport and is deliberately suspended. Cached content remains
    // the projection, so ChatView's loader predicate stays false throughout revalidation.
    #expect(!projection.needsBlockingLoader)
    #expect(store.cachedThread(companionID: cached.thread.companionID)?.thread.entries.count == 250)
    #expect(URLComponents(
        url: try #require(SuspendedThreadSyncURLProtocol.capturedURL),
        resolvingAgainstBaseURL: false
    )?.queryItems?.contains(URLQueryItem(name: "cursor", value: "prior-cursor")) == true)

    SuspendedThreadSyncURLProtocol.releaseResponse.signal()
    let refreshed = try await synchronization.value
    #expect(refreshed.value.thread.canSend)
    #expect(refreshed.value.cursor == "next-cursor")
    #expect(refreshed.value.isPartial)
}

@Test
func rosterDeltaMergesWithoutGapsDuplicatesAndPreservesServerOrder() throws {
    let first = try companionSummary(id: "22222222-2222-4222-8222-222222222222", name: "First")
    let second = try companionSummary(id: "33333333-3333-4333-8333-333333333333", name: "Second")
    let initial = CompanionRosterSnapshot(cursor: "one", companions: [first, second], sections: [])
    let changedSecond = try companionSummary(id: second.id, name: "Second updated")
    let delta = CompanionRosterDelta(
        cursor: "two",
        changedCompanions: [changedSecond],
        deletedCompanionIDs: [],
        companionIDs: [second.id, first.id],
        changedSections: [],
        deletedSectionIDs: [],
        sectionIDs: []
    )
    let merged = try delta.applying(to: initial)
    #expect(merged.companions.map(\.id) == [second.id, first.id])
    #expect(merged.companions.map(\.name) == ["Second updated", "First"])
    #expect(Set(merged.companions.map(\.id)).count == merged.companions.count)
}

@Test @MainActor
func companionInvalidationReachesTheVisibleThreadConsumer() async throws {
    let session = testSession()
    let store = SessionStore(
        apiURL: URL(string: "https://offline.invalid")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session))
    )
    let stream = store.companionInvalidations(companionID: "companion-x")
    let received = Task { @MainActor in
        for await _ in stream { return true }
        return false
    }
    #expect(store.hasVisibleInvalidationConsumer(companionID: "companion-x"))
    #expect(!store.hasVisibleInvalidationConsumer(companionID: "companion-y"))

    store.invalidateCompanion(companionID: "companion-x")
    #expect(await received.value)
}

@Test @MainActor
func aVisibleDifferentCompanionDoesNotSuppressBackgroundCacheRefresh() async throws {
    BackgroundRefreshURLProtocol.reset()
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [BackgroundRefreshURLProtocol.self]
    let client = APIClient(
        baseURL: URL(string: "https://example.test")!,
        session: URLSession(configuration: configuration),
        initialAuthority: session
    )
    let store = SessionStore(
        apiURL: URL(string: "https://example.test")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: fixture.cache,
        apiClient: client
    )
    let visibleX = store.companionInvalidations(companionID: "companion-x")
    defer { withExtendedLifetime(visibleX) {} }

    let companionY = "33333333-3333-4333-8333-333333333333"
    store.invalidateCompanion(companionID: companionY)
    for _ in 0..<500 where BackgroundRefreshURLProtocol.requestsStarted < 2 {
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(BackgroundRefreshURLProtocol.requestsStarted >= 2)
    for _ in 0..<500 {
        let rosterIsFresh = store.initialRosterSnapshot?.companions.map(\.id) == [companionY]
        let threadIsFresh = store.cachedThread(companionID: companionY)?.cursor == "fresh-thread"
        if rosterIsFresh && threadIsFresh { break }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }

    #expect(store.initialRosterSnapshot?.companions.map(\.id) == [companionY])
    #expect(store.cachedThread(companionID: companionY)?.cursor == "fresh-thread")
}

private func cacheFixture() throws -> (directory: URL, cache: SQLiteCompanionSnapshotCache) {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return (
        directory,
        try SQLiteCompanionSnapshotCache(
            url: directory.appending(path: "cache.sqlite3", directoryHint: .notDirectory)
        )
    )
}

private func testSession() -> Session {
    Session(
        cookie: "better-auth.session_token=test",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "owner@example.com", name: "Owner")
    )
}

private func companionSummary(
    id: String = "22222222-2222-4222-8222-222222222222",
    name: String = "Research"
) throws -> CompanionSummary {
    try decodeFixture(#"""
    {
      "id":"\#(id)","name":"\#(name)","persona":"Help","model_id":"model",
      "selected_skill_ids":[],"selected_mcp_account_ids":[],"icon":null,"section_id":null,
      "access":"owner","pinned":false,"hidden":false,"muted":false,"unread":false,
      "last_message":{"preview":"Ready","role":"assistant","created_at":"2026-08-29T00:00:00Z"},
      "runtime":{"state":"running","daemon_state":"running","replying":false,
        "last_error":null,"provider_ids":[],"latest_operation":null}
    }
    """#)
}

private func companionThread(entries: [TranscriptEntry]) throws -> CompanionThread {
    let entriesData = try JSONEncoder().encode(entries)
    let entriesJSON = String(decoding: entriesData, as: UTF8.self)
    return try decodeFixture(#"""
    {
      "companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-1",
      "read_only":false,"can_send":true,"transcription_available":true,
      "entries":\#(entriesJSON),"active_turn":null,"queued_count":0,"interrupted_turn":null
    }
    """#)
}

private func transcriptEntry(ordinal: Int) throws -> TranscriptEntry {
    try decodeFixture(#"""
    {
      "event_id":"event:\#(ordinal)","ordinal":\#(ordinal),"role":"assistant",
      "content":"Message \#(ordinal)","reasoning":null,"author_id":null,"author_name":null,
      "decision":null,"tool":null,"routine":null,"turn_id":null,"queued":false,
      "attachments":[],"created_at":"2026-08-29T00:00:00Z"
    }
    """#)
}

private func decodeFixture<Value: Decodable>(_ json: String) throws -> Value {
    try JSONDecoder().decode(Value.self, from: Data(json.utf8))
}
