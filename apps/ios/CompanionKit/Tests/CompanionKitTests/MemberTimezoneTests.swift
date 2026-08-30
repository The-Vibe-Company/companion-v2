import Foundation
import Testing
@testable import CompanionKit

private final class MemberTimezoneMockURLProtocol: URLProtocol, @unchecked Sendable {
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

private func memberTimezoneRequestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try #require(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

@Test
func decodesMemberTimezoneAndPreservesItInTheSession() throws {
    let identity = try JSONDecoder().decode(WhoAmI.self, from: Data(#"""
    {
      "userId":"user-1",
      "email":"member@example.com",
      "name":"Member",
      "timezone":"America/New_York",
      "org":null,
      "onboarded":false,
      "needsOnboarding":true
    }
    """#.utf8))

    let session = Session(cookie: "session=token", identity: identity)
    #expect(identity.timezone == "America/New_York")
    #expect(session.user.timezone == "America/New_York")
}

@Test
func profileAndResourceInputsEncodeSharedRoutePayloads() throws {
    let encoder = JSONEncoder()
    let profile = try JSONSerialization.jsonObject(
        with: encoder.encode(UpdateUserProfileInput(timezone: "Europe/Paris"))
    ) as? [String: String]
    #expect(profile == ["timezone": "Europe/Paris"])

    let routine = try JSONSerialization.jsonObject(
        with: encoder.encode(CreateCompanionRoutineInput(
            id: "33333333-3333-4333-8333-333333333333",
            name: "Daily brief",
            prompt: "Summarize today.",
            cron: "0 9 * * 1-5",
            timezone: "America/New_York"
        ))
    ) as? [String: Any]
    #expect(routine?["cron"] as? String == "0 9 * * 1-5")
    #expect(routine?["timezone"] as? String == "America/New_York")
    #expect(routine?["enabled"] as? Bool == true)

    let trigger = try JSONSerialization.jsonObject(
        with: encoder.encode(CreateCompanionTriggerInput(
            id: "44444444-4444-4444-8444-444444444444",
            name: "Pull request",
            prompt: "Summarize the pull request.",
            mode: .notify,
            provider: .github,
            providerAccountID: "55555555-5555-4555-8555-555555555555",
            target: CompanionTriggerTarget(repo: "acme/project", events: ["pull_request"])
        ))
    ) as? [String: Any]
    #expect(trigger?["provider"] as? String == "github")
    #expect(trigger?["mode"] as? String == "notify")
    #expect(trigger?["provider_account_id"] as? String == "55555555-5555-4555-8555-555555555555")
    #expect((trigger?["target"] as? [String: Any])?["repo"] as? String == "acme/project")

    let providerChange = try JSONSerialization.jsonObject(
        with: encoder.encode(UpdateCompanionTriggerInput(provider: .custom))
    ) as? [String: Any]
    #expect(providerChange?["provider"] as? String == "custom")
    #expect(providerChange?.keys.contains("target") == true)
    #expect(providerChange?["target"] is NSNull)
}

@Test
func triggerRegistrationRetryAndHistoryUseSharedRoutes() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MemberTimezoneMockURLProtocol.self]
    MemberTimezoneMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        let data: Data
        switch (requestURL.path, request.httpMethod) {
        case ("/v1/companions/companion-1/triggers/trigger-1/registration", "POST"):
            data = Data(#"{"trigger":{"id":"trigger-1","name":"CI failed","prompt":"Summarize failure","mode":"notify","provider":"github","provider_account_id":"account-1","registration_status":"registered","remote_hook_account_id":"account-1","remote_hook_id":"hook-42","enabled":true,"webhook_url":null,"last_fired_at":null,"last_error_message":null}}"#.utf8)
        case ("/v1/companions/companion-1/triggers/trigger-1/runs", "GET"):
            #expect(requestURL.query == "limit=20")
            data = Data(#"{"runs":[{"run_id":"22222222-2222-4222-8222-222222222222","companion_id":"companion-1","trigger":{"id":"trigger-1","name":"CI failed"},"status":"succeeded","mode":"notify","outcome":"surfaced","surface_mode":"notify","main_entry_event_id":"entry-1","relay_turn_id":null,"created_at":"2026-08-30T09:00:00.000Z","started_at":"2026-08-30T09:00:01.000Z","settled_at":"2026-08-30T09:00:02.000Z","error":null}],"next_cursor":null}"#.utf8)
        case ("/v1/companions/companion-1/trigger-runs/22222222-2222-4222-8222-222222222222", "GET"):
            #expect(requestURL.query == "entry_limit=50")
            data = Data(#"{"run":{"run_id":"22222222-2222-4222-8222-222222222222","companion_id":"companion-1","trigger":{"id":"trigger-1","name":"CI failed"},"status":"succeeded","mode":"notify","outcome":"surfaced","surface_mode":"notify","main_entry_event_id":"entry-1","relay_turn_id":null,"created_at":"2026-08-30T09:00:00.000Z","started_at":"2026-08-30T09:00:01.000Z","settled_at":"2026-08-30T09:00:02.000Z","error":null,"internal_entries":[{"event_id":"payload-1","ordinal":0,"role":"user","content":"{\"ref\":\"refs/heads/main\"}","reasoning":null,"tool":null,"decision":null,"created_at":"2026-08-30T09:00:00.000Z"}],"next_entry_cursor":null}}"#.utf8)
        default:
            Issue.record("Unexpected trigger v2 route: \(request.httpMethod ?? "") \(requestURL.absoluteString)")
            data = Data()
        }
        return (try #require(HTTPURLResponse(
            url: requestURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )), data)
    }
    defer { MemberTimezoneMockURLProtocol.handler = nil }

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

    let retried = try await client.retryCompanionTriggerRegistration(
        companionID: "companion-1",
        triggerID: "trigger-1"
    )
    #expect(retried.registrationStatus == .registered)
    #expect(retried.providerAccountID == "account-1")
    #expect(retried.remoteHookID == "hook-42")

    let history = try await client.listCompanionTriggerRuns(
        companionID: "companion-1",
        triggerID: "trigger-1",
        limit: 20
    )
    #expect(history.runs.first?.mode == .notify)
    #expect(history.runs.first?.surfaceMode == .notify)

    let detail = try await client.readCompanionTriggerRun(
        companionID: "companion-1",
        runID: "22222222-2222-4222-8222-222222222222"
    )
    #expect(detail.internalEntries.first?.content.contains("refs/heads/main") == true)
}

@Test
func formatsInstantsInTheMemberTimezone() throws {
    let instant = "2026-08-27T13:00:00.000Z"
    let date = try #require(MemberTimezone.parseInstant(instant))
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try #require(TimeZone(identifier: "America/New_York"))
    #expect(calendar.component(.hour, from: date) == 9)

    let formatted = MemberTimezone.formatInstant(
        instant,
        in: "America/New_York",
        locale: Locale(identifier: "en_US_POSIX")
    )
    #expect(formatted?.contains("9:00") == true)
}

@Test
func apiClientUsesProfileRoutineAndTriggerRoutes() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MemberTimezoneMockURLProtocol.self]
    MemberTimezoneMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        let body = try #require(
            JSONSerialization.jsonObject(with: memberTimezoneRequestBody(request)) as? [String: Any]
        )
        let responseData: Data
        switch (requestURL.path, request.httpMethod) {
        case ("/v1/users/me", "PUT"):
            #expect(body["timezone"] as? String == "Europe/Paris")
            #expect(body.keys.contains("name") == false)
            responseData = Data(#"{"id":"user-1","name":"Member","initials":"ME","timezone":"Europe/Paris"}"#.utf8)
        case ("/v1/companions/companion-1/routines", "POST"):
            #expect(body["cron"] as? String == "0 9 * * 1-5")
            #expect(body["timezone"] as? String == "Europe/Paris")
            responseData = Data(#"{"routine":{"id":"33333333-3333-4333-8333-333333333333","name":"Daily brief","prompt":"Summarize today.","cron":"0 9 * * 1-5","timezone":"Europe/Paris","enabled":true,"next_fire_at":"2026-08-27T07:00:00.000Z","last_fired_at":null,"last_error_message":null}}"#.utf8)
        case ("/v1/companions/companion-1/triggers", "POST"):
            #expect(body["provider"] as? String == "github")
            responseData = Data(#"{"trigger":{"id":"44444444-4444-4444-8444-444444444444","name":"Pull request","prompt":"Summarize the pull request.","provider":"github","target":{"repo":"acme/project","events":["pull_request"]},"registration_status":"manual","enabled":true,"webhook_url":null,"last_fired_at":null,"last_error_message":null}}"#.utf8)
        default:
            Issue.record("Unexpected route: \(request.httpMethod ?? "") \(requestURL.path)")
            responseData = Data()
        }
        let response = try #require(HTTPURLResponse(
            url: requestURL,
            statusCode: requestURL.path == "/v1/users/me" ? 200 : 201,
            httpVersion: nil,
            headerFields: nil
        ))
        return (response, responseData)
    }
    defer { MemberTimezoneMockURLProtocol.handler = nil }

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

    let profile = try await client.updateUserProfile(timezone: "Europe/Paris")
    #expect(profile.timezone == "Europe/Paris")
    let createdRoutine = try await client.createCompanionRoutine(
        companionID: "companion-1",
        input: CreateCompanionRoutineInput(
            id: "33333333-3333-4333-8333-333333333333",
            name: "Daily brief",
            prompt: "Summarize today.",
            cron: "0 9 * * 1-5",
            timezone: "Europe/Paris"
        )
    )
    #expect(createdRoutine.timezone == "Europe/Paris")
    let createdTrigger = try await client.createCompanionTrigger(
        companionID: "companion-1",
        input: CreateCompanionTriggerInput(
            id: "44444444-4444-4444-8444-444444444444",
            name: "Pull request",
            prompt: "Summarize the pull request.",
            provider: .github,
            target: CompanionTriggerTarget(repo: "acme/project", events: ["pull_request"])
        )
    )
    #expect(createdTrigger.prompt == "Summarize the pull request.")
    #expect(createdTrigger.provider == "github")
    #expect(createdTrigger.target?.repo == "acme/project")
}
