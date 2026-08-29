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
    nonisolated(unsafe) static var requestStarted = DispatchSemaphore(value: 0)
    nonisolated(unsafe) static var releaseResponse = DispatchSemaphore(value: 0)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requestStarted.signal()
        _ = Self.releaseResponse.wait(timeout: .now() + 5)
        let payload = #"""
        {
          "cursor":"next-cursor",
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
    let snapshot = CompanionThreadSnapshot.bounded(
        cursor: "thread-cursor",
        thread: try companionThread(entries: entries)
    )
    try cache.saveThread(snapshot, scope: "org-a:user-a", companionID: snapshot.thread.companionID)
    let restored = try #require(cache.thread(
        scope: "org-a:user-a",
        companionID: snapshot.thread.companionID
    ))
    #expect(restored.isPartial)
    #expect(restored.thread.entries.count == 250)
    #expect(restored.thread.entries.first?.ordinal == 50)
}

@Test @MainActor
func offlineSessionRestoresRosterWithoutWaitingForNetwork() throws {
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let snapshot = CompanionRosterSnapshot(
        cursor: "roster-cursor",
        companions: [try companionSummary()],
        sections: []
    )
    try fixture.cache.saveRoster(snapshot, scope: "org-1:user-1")

    let store = SessionStore(
        apiURL: URL(string: "https://offline.invalid")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: fixture.cache
    )

    #expect(store.phase == .active(session))
    #expect(store.initialRosterSnapshot == snapshot)
    #expect((store.initialCacheRestoreMilliseconds ?? .infinity) < 50)
}

@Test @MainActor
func cachedThreadRemainsRenderableWhileDeltaSynchronizationIsInFlight() async throws {
    SuspendedThreadSyncURLProtocol.requestStarted = DispatchSemaphore(value: 0)
    SuspendedThreadSyncURLProtocol.releaseResponse = DispatchSemaphore(value: 0)
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let cached = CompanionThreadSnapshot.bounded(
        cursor: "prior-cursor",
        thread: try companionThread(entries: [try transcriptEntry(ordinal: 1)])
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
    await Task.detached {
        _ = SuspendedThreadSyncURLProtocol.requestStarted.wait(timeout: .now() + 5)
    }.value

    // The request has reached the transport and is deliberately suspended. Cached content remains
    // the projection, so ChatView's loader predicate stays false throughout revalidation.
    #expect(!projection.needsBlockingLoader)
    #expect(store.cachedThread(companionID: cached.thread.companionID)?.thread.entries.count == 1)

    SuspendedThreadSyncURLProtocol.releaseResponse.signal()
    let refreshed = try await synchronization.value
    #expect(refreshed.value.thread.canSend)
    #expect(refreshed.value.cursor == "next-cursor")
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
    let stream = store.companionInvalidations()
    let received = Task { @MainActor in
        for await companionID in stream { return companionID }
        return nil
    }

    store.invalidateCompanion(companionID: "companion-x")
    #expect(await received.value == "companion-x")
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
