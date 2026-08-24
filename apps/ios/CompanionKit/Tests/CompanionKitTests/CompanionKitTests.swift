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

private final class ManagementMockURLProtocol: URLProtocol, @unchecked Sendable {
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

private func requestBody(_ request: URLRequest) throws -> Data {
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
func decodesCompanionIconCatalogIndexes() throws {
    let data = Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"glm-5.3",
      "icon":{"shape":6,"mouth":3,"accessory":5,"color":7},
      "hidden":false,
      "unread":true,
      "last_message":null,
      "runtime":{"state":"running","replying":false,"last_error":null}
    }
    """#.utf8)
    let companion = try JSONDecoder().decode(CompanionSummary.self, from: data)
    #expect(companion.icon == .init(shape: 6, mouth: 3, accessory: 5, color: 7))
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
func usesRealCompanionManagementRoutesAndRetainsProviderOAuthAuthority() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagementMockURLProtocol.self]
    ManagementMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        let response: HTTPURLResponse
        let data: Data
        switch requestURL.path {
        case "/v1/companion-providers":
            #expect(request.httpMethod == "GET")
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 200, httpVersion: nil, headerFields: nil))
            data = Data(#"{"catalog":[{"id":"anthropic","name":"Claude","auth_methods":["api_key","subscription"],"description":"Claude models","models":[{"id":"claude-sonnet","name":"Sonnet","default":true}]}],"connections":[{"provider_id":"anthropic","auth_method":"api_key","connected_by":"user-1","created_at":"2026-08-24T12:00:00.000Z","updated_at":"2026-08-24T12:00:00.000Z"}],"default_provider_id":"anthropic","can_manage":true}"#.utf8)

        case "/v1/companions":
            #expect(request.httpMethod == "POST")
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(json["name"] as? String == "Luna")
            #expect(json["provider_id"] as? String == "anthropic")
            #expect(json["model_id"] as? String == "claude-sonnet")
            #expect(json["selected_mcp_account_ids"] as? [String] == ["b4d8a690-32d2-4dff-b6e0-3f742c056f95"])
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 201, httpVersion: nil, headerFields: nil))
            data = Data(#"{"companion":{"id":"c96ab360-00f3-4497-a51a-51442db8add1","name":"Luna","persona":null,"model_id":"claude-sonnet","icon":{"shape":6,"mouth":1,"accessory":6,"color":2},"hidden":false,"unread":false,"last_message":null,"runtime":{"state":"not_created","replying":false,"last_error":null}}}"#.utf8)

        case "/v1/companion-plugins":
            #expect(request.httpMethod == "POST")
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(json["transport"] as? String == "http")
            #expect(json["url"] as? String == "https://mcp.example.com")
            #expect(json["credential_name"] as? String == "Authorization")
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 201, httpVersion: nil, headerFields: nil))
            data = Data(#"{"account":{"id":"b4d8a690-32d2-4dff-b6e0-3f742c056f95","provider":"custom","label":"Team MCP","transport":"http","endpoint":"https://mcp.example.com","connected":true,"created_at":"2026-08-24T12:00:00.000Z","updated_at":"2026-08-24T12:00:00.000Z"}}"#.utf8)

        case "/v1/companion-providers/oauth/start":
            #expect(request.httpMethod == "POST")
            response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Set-Cookie": "companion_provider_oauth=signed-flow; Path=/v1/companion-providers/oauth; HttpOnly"]
            ))
            data = Data(#"{"flow":"device_code","provider_id":"openai-codex","verification_url":"https://auth.openai.com/device","user_code":"ABCD-EFGH","poll_interval_seconds":5,"expires_at":"2026-08-24T12:10:00.000Z"}"#.utf8)

        case "/v1/companion-providers/oauth/poll":
            #expect(request.httpMethod == "POST")
            let cookie = request.value(forHTTPHeaderField: "Cookie") ?? ""
            #expect(cookie.contains("better-auth.session_token=session"))
            #expect(cookie.contains("companion_provider_oauth=signed-flow"))
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 202, httpVersion: nil, headerFields: nil))
            data = Data(#"{"status":"pending"}"#.utf8)

        default:
            Issue.record("Unexpected management route: \(requestURL.path)")
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 404, httpVersion: nil, headerFields: nil))
            data = Data()
        }
        return (response, data)
    }
    defer { ManagementMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "stan@example.com", name: "Stan")
    ))

    let providers = try await client.listCompanionProviders()
    #expect(providers.defaultProviderID == "anthropic")
    #expect(providers.connectedDefinitions.map(\.id) == ["anthropic"])

    let companion = try await client.createCompanion(.init(
        name: "Luna",
        providerID: "anthropic",
        modelID: "claude-sonnet",
        selectedMCPAccountIDs: ["b4d8a690-32d2-4dff-b6e0-3f742c056f95"],
        icon: .init(shape: 6, mouth: 1, accessory: 6, color: 2)
    ))
    #expect(companion.name == "Luna")

    let plugin = try await client.saveCompanionPlugin(.init(
        provider: "custom",
        label: "Team MCP",
        transport: .http,
        url: "https://mcp.example.com",
        credentialName: "Authorization",
        credentialValue: "Bearer secret"
    ))
    #expect(plugin.label == "Team MCP")

    let pluginOAuthRequest = try await client.companionPluginOAuthRequest(
        serverName: "app.linear/linear",
        label: "client-a"
    )
    #expect(pluginOAuthRequest.url?.path == "/v1/companion-plugins/oauth/start")
    #expect(pluginOAuthRequest.httpMethod == "POST")
    #expect(pluginOAuthRequest.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=session")
    #expect(pluginOAuthRequest.value(forHTTPHeaderField: "x-companion-org") == "org-1")
    let pluginOAuthBody = try #require(pluginOAuthRequest.httpBody)
    let pluginOAuthJSON = try #require(JSONSerialization.jsonObject(with: pluginOAuthBody) as? [String: String])
    #expect(pluginOAuthJSON == ["server_name": "app.linear/linear", "label": "client-a"])

    let oauth = try await client.startCompanionProviderOAuth(providerID: "openai-codex")
    #expect(oauth.userCode == "ABCD-EFGH")
    let poll = try await client.pollCompanionProviderOAuth()
    #expect(poll.status == .pending)
}

@Test
func liveLocalManagementAccountWhenConfigured() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let rawURL = environment["COMPANION_IOS_MANAGEMENT_TEST_API_URL"],
          let apiURL = URL(string: rawURL),
          let email = environment["COMPANION_IOS_MANAGEMENT_TEST_EMAIL"],
          let password = environment["COMPANION_IOS_MANAGEMENT_TEST_PASSWORD"] else { return }

    let client = APIClient(baseURL: apiURL)
    let session = try await client.signIn(email: email, password: password)
    #expect(session.orgID != nil)

    let providers = try await client.listCompanionProviders()
    #expect(Set(providers.catalog.map(\.id)) == Set([
        "anthropic",
        "openai-codex",
        "kimi-coding",
        "moonshotai",
        "zai",
        "openai",
        "google",
    ]))

    let plugins = try await client.listCompanionPlugins()
    let linearLabels = plugins
        .filter { $0.provider == "linear" }
        .map(\.label)
        .sorted()
    #expect(linearLabels == ["client", "work"])
    #expect(Set(plugins.map(\.id)).count == plugins.count)
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
