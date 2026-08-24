import Foundation
import Testing
@testable import CompanionKit

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
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
func usesTheSharedAPIContract() {
    #expect(CompanionKit.apiRootPath == "/v1")
}

@Test
func decodesUnknownRuntimeStateWithoutRejectingTheRoster() throws {
    let data = Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"glm-5.3",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{"state":"future_state","replying":false,"last_error":null},
      "future_field":true
    }
    """#.utf8)
    let companion = try JSONDecoder().decode(CompanionSummary.self, from: data)
    #expect(companion.runtime.state == .unknown)
}

@Test
func decodesViewerAndAuthorIdentityForSharedThreads() throws {
    let data = Data(#"""
    {
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "viewer_id":"viewer-1",
      "read_only":false,
      "can_send":true,
      "entries":[{
        "event_id":"msg:17f8b827-8a06-4ef8-9352-58cc03c849a4",
        "ordinal":1,
        "role":"user",
        "content":"Shared update",
        "author_id":"editor-2",
        "author_name":"Morgan",
        "queued":false,
        "created_at":"2026-08-24T11:00:00.000Z"
      }],
      "queued_count":0
    }
    """#.utf8)
    let thread = try JSONDecoder().decode(CompanionThread.self, from: data)
    #expect(thread.viewerID == "viewer-1")
    #expect(thread.entries.first?.authorID == "editor-2")
    #expect(thread.entries.first?.authorName == "Morgan")
}

@Test
func extractsOnlyTheSessionCookieFromAuthHeaders() throws {
    let response = try #require(HTTPURLResponse(
        url: URL(string: "http://127.0.0.1:3001/v1/auth/login")!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: ["Set-Cookie": "better-auth.session_token=opaque; Path=/; HttpOnly; SameSite=Lax"]
    ))
    #expect(APIClient.sessionCookie(from: response) == "better-auth.session_token=opaque")
}

@Test
func extractsSessionCookieFromTheNativeGoogleCallback() {
    let header = "better-auth.session_token=google-session; Path=/; HttpOnly; SameSite=Lax"
    #expect(APIClient.sessionCookie(fromSetCookieHeader: header) == "better-auth.session_token=google-session")
}

@Test
func buildsTheGoogleAuthorizationProxyWithExpoState() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    MockURLProtocol.handler = { request in
        #expect(request.url?.path == "/auth/sign-in/social")
        #expect(request.value(forHTTPHeaderField: "expo-origin") == "dev.companion.mobile.dev://")
        let requestURL = try #require(request.url)
        let response = try #require(HTTPURLResponse(
            url: requestURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Set-Cookie": "better-auth.oauth_state=signed-state; Path=/; HttpOnly"]
        ))
        let data = Data(#"{"url":"https://accounts.google.com/o/oauth2/auth?state=state","redirect":true}"#.utf8)
        return (response, data)
    }
    defer { MockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    let authorization = try await client.beginGoogleSignIn(callbackScheme: "dev.companion.mobile.dev")
    let components = try #require(URLComponents(url: authorization.proxyURL, resolvingAgainstBaseURL: false))
    #expect(components.path == "/auth/expo-authorization-proxy")
    #expect(components.queryItems?.first(where: { $0.name == "oauthState" })?.value == "signed-state")
    #expect(components.queryItems?.first(where: { $0.name == "authorizationURL" })?.value?.hasPrefix("https://accounts.google.com/") == true)
}

@Test
func liveLocalLoginRosterAndMessageWhenConfigured() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let rawURL = environment["COMPANION_IOS_E2E_API_URL"],
          let apiURL = URL(string: rawURL),
          let email = environment["COMPANION_IOS_E2E_EMAIL"],
          let password = environment["COMPANION_IOS_E2E_PASSWORD"] else { return }

    let client = APIClient(baseURL: apiURL)
    let session = try await client.signIn(email: email, password: password)
    #expect(session.orgID != nil)
    let companions = try await client.listCompanions()
    let companion = try #require(companions.first(where: { $0.name == "Zai E2E La Paz" }))
    let marker = "E2E_IOS_NATIVE_OK"
    let previousOrdinal = try await client.thread(companionID: companion.id).entries
        .map(\.ordinal)
        .max() ?? 0
    try await client.sendMessage(
        companionID: companion.id,
        content: "Réponds uniquement par \(marker)",
        clientMessageID: UUID()
    )

    for _ in 0..<45 {
        let thread = try await client.thread(companionID: companion.id)
        if thread.entries.contains(where: {
            $0.ordinal > previousOrdinal && $0.role == "assistant" && $0.content == marker
        }) {
            return
        }
        try await Task.sleep(for: .seconds(2))
    }
    Issue.record("The native API flow did not observe the expected z.ai reply.")
}
