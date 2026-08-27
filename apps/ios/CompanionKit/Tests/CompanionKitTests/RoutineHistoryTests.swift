import Foundation
import Testing
@testable import CompanionKit

private final class RoutineHistoryMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let handler = try #require(Self.handler)
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@Test
func requestsAndDecodesRoutineHistoryUsingTheSharedContract() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RoutineHistoryMockURLProtocol.self]
    RoutineHistoryMockURLProtocol.handler = { request in
        let url = try #require(request.url)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=session")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-1")

        if components.percentEncodedPath == "/v1/companions/companion%20id/routines/routine%20id/runs" {
            let query = try #require(components.queryItems)
            #expect(query == [
                URLQueryItem(name: "limit", value: "20"),
                URLQueryItem(name: "cursor", value: "cursor id"),
            ])
            let response = try #require(HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            return (response, Data(#"{"runs":[{"run_id":"33333333-3333-4333-8333-333333333333","companion_id":"11111111-1111-4111-8111-111111111111","routine":{"id":"22222222-2222-4222-8222-222222222222","name":"Morning brief"},"status":"succeeded","outcome":"surfaced","surface_mode":"notify","main_entry_event_id":"routine-return:1","relay_turn_id":null,"created_at":"2026-08-27T09:00:00.000Z","started_at":"2026-08-27T09:00:01.000Z","settled_at":"2026-08-27T09:00:05.000Z","error":null}],"next_cursor":null}"#.utf8))
        }

        if components.percentEncodedPath == "/v1/companions/companion%20id/routine-runs/run%20id" {
            let query = try #require(components.queryItems)
            #expect(query == [
                URLQueryItem(name: "entry_limit", value: "50"),
                URLQueryItem(name: "entry_cursor", value: "0"),
            ])
            let response = try #require(HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            return (response, Data(#"{"run":{"run_id":"33333333-3333-4333-8333-333333333333","companion_id":"11111111-1111-4111-8111-111111111111","routine":{"id":"22222222-2222-4222-8222-222222222222","name":"Morning brief"},"status":"succeeded","outcome":"surfaced","surface_mode":"notify","main_entry_event_id":"routine-return:1","relay_turn_id":null,"created_at":"2026-08-27T09:00:00.000Z","started_at":"2026-08-27T09:00:01.000Z","settled_at":"2026-08-27T09:00:05.000Z","error":null,"internal_entries":[{"event_id":"routine:assistant:1","ordinal":0,"role":"assistant","content":"Checked the deployment.","reasoning":"Compared release notes.","tool":null,"decision":null,"created_at":"2026-08-27T09:00:02.000Z"}],"next_entry_cursor":0}}}"#.utf8))
        }

        Issue.record("Unexpected routine history route: \(url.absoluteString)")
        let response = try #require(HTTPURLResponse(
            url: url,
            statusCode: 404,
            httpVersion: nil,
            headerFields: nil
        ))
        return (response, Data())
    }
    defer { RoutineHistoryMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "member@example.com", name: "Member")
    ))

    let list = try await client.listCompanionRoutineRuns(
        companionID: "companion id",
        routineID: "routine id",
        limit: 20,
        cursor: "cursor id"
    )
    #expect(list.runs.count == 1)
    #expect(list.runs[0].outcome == .surfaced)
    #expect(list.runs[0].surfaceMode == .notify)

    let detail = try await client.readCompanionRoutineRun(
        companionID: "companion id",
        runID: "run id",
        entryLimit: 50,
        entryCursor: 0
    )
    #expect(detail.internalEntries.first?.ordinal == 0)
    #expect(detail.internalEntries.first?.reasoning == "Compared release notes.")
}

@Test
func decodesRoutineOriginWithAndWithoutDurableRunID() throws {
    let withRun = try JSONDecoder().decode(
        TranscriptEntry.self,
        from: Data(#"{"event_id":"msg:1","ordinal":0,"role":"user","content":"private prompt","author_id":null,"author_name":null,"routine":{"id":"22222222-2222-4222-8222-222222222222","name":"Morning brief","run_id":"33333333-3333-4333-8333-333333333333"},"turn_id":"33333333-3333-4333-8333-333333333333","queued":false,"attachments":[],"created_at":"2026-08-27T09:00:00.000Z"}"#.utf8)
    )
    #expect(withRun.routine?.id == "22222222-2222-4222-8222-222222222222")
    #expect(withRun.routine?.runID == "33333333-3333-4333-8333-333333333333")

    let oldMarker = try JSONDecoder().decode(
        TranscriptEntry.self,
        from: Data(#"{"event_id":"msg:2","ordinal":1,"role":"user","content":"old prompt","author_id":null,"author_name":null,"routine":{"id":null,"name":"Deleted routine"},"turn_id":null,"queued":false,"attachments":[],"created_at":"2026-08-27T09:01:00.000Z"}"#.utf8)
    )
    #expect(oldMarker.routine?.id == nil)
    #expect(oldMarker.routine?.runID == nil)
}
