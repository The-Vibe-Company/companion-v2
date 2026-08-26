import Foundation

public struct APIError: Error, LocalizedError, Equatable, Sendable {
    public let status: Int
    public let code: String?
    public let message: String

    public init(status: Int, code: String?, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

public actor APIClient {
    public struct GoogleAuthorization: Equatable, Sendable {
        public let proxyURL: URL

        public init(proxyURL: URL) {
            self.proxyURL = proxyURL
        }
    }

    private struct ErrorPayload: Decodable {
        let code: String?
        let error: String?
        let message: String?
    }

    private struct CompanionListEnvelope: Decodable {
        let companions: [CompanionSummary]
    }

    private struct ThreadEnvelope: Decodable {
        let thread: CompanionThread
    }

    private struct CompanionEnvelope: Decodable {
        let companion: CompanionSummary
    }

    private struct OperationEnvelope: Decodable {
        let operation: CompanionOperationSummary
    }

    private struct ProviderConnectionEnvelope: Decodable {
        let connection: CompanionProviderConnection
    }

    private struct PluginListEnvelope: Decodable {
        let accounts: [CompanionPluginAccount]
    }

    private struct PluginAccountEnvelope: Decodable {
        let account: CompanionPluginAccount
    }

    private struct RoutineListEnvelope: Decodable {
        let routines: [CompanionRoutine]
    }

    private struct TriggerListEnvelope: Decodable {
        let triggers: [CompanionTrigger]
    }

    private struct SocialSignInResponse: Decodable {
        let url: URL
        let redirect: Bool
    }

    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var authority: Session?
    private var providerOAuthCookie: String?

    public init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.httpCookieAcceptPolicy = .never
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            configuration.timeoutIntervalForRequest = 30
            self.session = URLSession(configuration: configuration)
        }
    }

    public func setAuthority(_ authority: Session?) {
        self.authority = authority
    }

    public func currentAuthority() -> Session? {
        authority
    }

    public func signIn(email: String, password: String) async throws -> Session {
        authority = nil
        let body = try encoder.encode([
            "email": email,
            "password": password,
            "name": email.split(separator: "@").first.map(String.init) ?? email,
        ])
        let (_, response) = try await perform(
            path: "/v1/auth/login",
            method: "POST",
            body: body,
            acceptedStatuses: 200..<300
        )
        guard let cookie = Self.sessionCookie(from: response) else {
            throw APIError(status: 500, code: "missing_session", message: "The server did not return a session.")
        }
        authority = Session(
            cookie: cookie,
            orgID: nil,
            needsOnboarding: true,
            user: .init(id: "pending", email: email, name: nil)
        )
        let identity = try await whoAmI()
        let authenticated = Session(cookie: authority?.cookie ?? cookie, identity: identity)
        authority = authenticated
        return authenticated
    }

    public func signOut() async {
        _ = try? await perform(path: "/v1/auth/logout", method: "POST", body: nil)
        authority = nil
    }

    public func beginGoogleSignIn(callbackScheme: String) async throws -> GoogleAuthorization {
        authority = nil
        let callbackURL = "\(callbackScheme)://"
        let body = try encoder.encode([
            "provider": "google",
            "callbackURL": callbackURL,
            "newUserCallbackURL": callbackURL,
            "errorCallbackURL": callbackURL,
        ])
        let (data, response) = try await perform(
            path: "/auth/sign-in/social",
            method: "POST",
            body: body,
            additionalHeaders: [
                "expo-origin": callbackURL,
                "x-skip-oauth-proxy": "true",
            ]
        )
        let social: SocialSignInResponse
        do {
            social = try decoder.decode(SocialSignInResponse.self, from: data)
        } catch {
            throw APIError(status: 500, code: "google_unavailable", message: "Google sign-in is unavailable.")
        }
        guard social.redirect else {
            throw APIError(status: 500, code: "google_unavailable", message: "Google sign-in is unavailable.")
        }
        var components = URLComponents(
            url: URL(string: "/auth/expo-authorization-proxy", relativeTo: baseURL)!,
            resolvingAgainstBaseURL: true
        )
        var items = [URLQueryItem(name: "authorizationURL", value: social.url.absoluteString)]
        if let oauthState = Self.cookieValue(suffix: ".oauth_state", from: response) {
            items.append(URLQueryItem(name: "oauthState", value: oauthState))
        }
        components?.queryItems = items
        guard let proxyURL = components?.url else {
            throw APIError(status: 0, code: "invalid_google_url", message: "Google sign-in could not be started.")
        }
        return GoogleAuthorization(proxyURL: proxyURL)
    }

    public func completeGoogleSignIn(callbackURL: URL) async throws -> Session {
        let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems
        guard let setCookie = items?.first(where: { $0.name == "cookie" })?.value,
              let cookie = Self.sessionCookie(fromSetCookieHeader: setCookie) else {
            throw APIError(status: 401, code: "invalid_google_callback", message: "Google did not return a session.")
        }
        authority = Session(
            cookie: cookie,
            orgID: nil,
            needsOnboarding: true,
            user: .init(id: "pending", email: "pending", name: nil)
        )
        let identity = try await whoAmI()
        let authenticated = Session(cookie: authority?.cookie ?? cookie, identity: identity)
        authority = authenticated
        return authenticated
    }

    public func whoAmI() async throws -> WhoAmI {
        try await decode(WhoAmI.self, path: "/v1/auth/whoami")
    }

    public func listCompanions() async throws -> [CompanionSummary] {
        try await decode(CompanionListEnvelope.self, path: "/v1/companions").companions
    }

    public func connectedResources(
        companionID: String,
        selectedSkillIDs: [String]
    ) async throws -> CompanionConnectedResources {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        async let availableSkills = decode(
            [CompanionSkillSummary].self,
            path: "/v1/skills?lib=accessible"
        )
        async let routineEnvelope = decode(
            RoutineListEnvelope.self,
            path: "/v1/companions/\(id)/routines"
        )
        async let triggerEnvelope = decode(
            TriggerListEnvelope.self,
            path: "/v1/companions/\(id)/triggers"
        )
        let (skillRows, routineResult, triggerResult) = try await (
            availableSkills,
            routineEnvelope,
            triggerEnvelope
        )

        var skillsByID: [String: CompanionSkillSummary] = [:]
        for skill in skillRows { skillsByID[skill.id] = skill }
        let skills = selectedSkillIDs.compactMap { skillsByID[$0] }
        return CompanionConnectedResources(
            skills: skills,
            hiddenSkillCount: selectedSkillIDs.count - skills.count,
            routines: routineResult.routines,
            triggers: triggerResult.triggers
        )
    }

    public func registerNotificationDevice(
        installationID: UUID,
        registration: NotificationDeviceRegistration
    ) async throws {
        let body = try encoder.encode(registration)
        _ = try await perform(
            path: "/v1/notification-devices/\(installationID.uuidString.lowercased())",
            method: "PUT",
            body: body
        )
    }

    public func unregisterNotificationDevice(installationID: UUID) async throws {
        _ = try await perform(
            path: "/v1/notification-devices/\(installationID.uuidString.lowercased())",
            method: "DELETE",
            body: nil
        )
    }

    public func createCompanion(_ input: CreateCompanionInput) async throws -> CompanionSummary {
        let body = try encoder.encode(input)
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions",
            method: "POST",
            body: body
        ).companion
    }

    public func updateCompanion(
        companionID: String,
        input: UpdateCompanionInput
    ) async throws -> CompanionSummary {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        let body = try encoder.encode(input)
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions/\(id)",
            method: "PATCH",
            body: body
        ).companion
    }

    public func deleteCompanion(
        companionID: String,
        requestID: UUID
    ) async throws -> CompanionOperationSummary {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        return try await decode(
            OperationEnvelope.self,
            path: "/v1/companions/\(id)",
            method: "DELETE",
            body: nil,
            additionalHeaders: ["Idempotency-Key": requestID.uuidString.lowercased()]
        ).operation
    }

    public func listCompanionProviders() async throws -> CompanionProvidersResponse {
        try await decode(CompanionProvidersResponse.self, path: "/v1/companion-providers")
    }

    public func saveCompanionProvider(
        providerID: String,
        credential: String
    ) async throws -> CompanionProviderConnection {
        let id = providerID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? providerID
        let body = try encoder.encode([
            "auth_method": "api_key",
            "credential": credential,
        ])
        return try await decode(
            ProviderConnectionEnvelope.self,
            path: "/v1/companion-providers/\(id)",
            method: "PUT",
            body: body
        ).connection
    }

    public func setDefaultCompanionProvider(providerID: String) async throws {
        let body = try encoder.encode(["provider_id": providerID])
        _ = try await perform(
            path: "/v1/companion-providers/default",
            method: "PUT",
            body: body
        )
    }

    public func deleteCompanionProvider(providerID: String) async throws {
        let id = providerID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? providerID
        _ = try await perform(
            path: "/v1/companion-providers/\(id)",
            method: "DELETE",
            body: nil
        )
    }

    public func startCompanionProviderOAuth(
        providerID: String
    ) async throws -> CompanionProviderOAuthStart {
        let body = try encoder.encode(["provider_id": providerID])
        let (data, response) = try await perform(
            path: "/v1/companion-providers/oauth/start",
            method: "POST",
            body: body,
            timeout: 35
        )
        guard let cookie = Self.cookie(suffix: "companion_provider_oauth", from: response) else {
            throw APIError(
                status: 500,
                code: "missing_oauth_session",
                message: "The server did not return a provider sign-in session."
            )
        }
        providerOAuthCookie = cookie
        do {
            return try decoder.decode(CompanionProviderOAuthStart.self, from: data)
        } catch {
            providerOAuthCookie = nil
            throw APIError(status: 500, code: "invalid_response", message: "The provider sign-in response was unreadable.")
        }
    }

    public func completeCompanionProviderOAuth(
        authorizationCode: String
    ) async throws -> CompanionProviderConnection {
        let body = try encoder.encode(["authorization_code": authorizationCode])
        let result = try await decode(
            ProviderConnectionEnvelope.self,
            path: "/v1/companion-providers/oauth/complete",
            method: "POST",
            body: body,
            additionalHeaders: providerOAuthHeaders(),
            timeout: 35
        ).connection
        providerOAuthCookie = nil
        return result
    }

    public func pollCompanionProviderOAuth() async throws -> CompanionProviderOAuthPoll {
        let result = try await decode(
            CompanionProviderOAuthPoll.self,
            path: "/v1/companion-providers/oauth/poll",
            method: "POST",
            body: nil,
            additionalHeaders: providerOAuthHeaders(),
            timeout: 65
        )
        if result.status == .connected { providerOAuthCookie = nil }
        return result
    }

    public func cancelCompanionProviderOAuth() {
        providerOAuthCookie = nil
    }

    public func listCompanionPlugins() async throws -> [CompanionPluginAccount] {
        try await decode(PluginListEnvelope.self, path: "/v1/companion-plugins").accounts
    }

    public func saveCompanionPlugin(
        _ input: SaveCompanionPluginInput
    ) async throws -> CompanionPluginAccount {
        let body = try encoder.encode(input)
        return try await decode(
            PluginAccountEnvelope.self,
            path: "/v1/companion-plugins",
            method: "POST",
            body: body
        ).account
    }

    /// Builds the authenticated POST loaded by the in-app OAuth browser. Performing the start
    /// request inside that browser keeps its short-lived, HttpOnly callback cookie in the same
    /// isolated cookie store as the provider redirect without introducing a mobile-only API.
    public func companionPluginOAuthRequest(
        serverName: String,
        label: String
    ) throws -> URLRequest {
        let body = try encoder.encode([
            "server_name": serverName,
            "label": label,
        ])
        return try makeRequest(
            path: "/v1/companion-plugins/oauth/start",
            method: "POST",
            body: body,
            timeout: 12
        )
    }

    public func deleteCompanionPlugin(accountID: String) async throws {
        let id = accountID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? accountID
        _ = try await perform(
            path: "/v1/companion-plugins/\(id)",
            method: "DELETE",
            body: nil
        )
    }

    public func thread(companionID: String) async throws -> CompanionThread {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        return try await decode(ThreadEnvelope.self, path: "/v1/companions/\(id)/thread").thread
    }

    public func sendMessage(companionID: String, content: String, clientMessageID: UUID) async throws {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        let body = try encoder.encode([
            "content": content,
            "client_message_id": clientMessageID.uuidString.lowercased(),
        ])
        _ = try await perform(
            path: "/v1/companions/\(id)/messages",
            method: "POST",
            body: body,
            acceptedStatuses: 200..<300,
            additionallyAcceptedStatus: 409,
            timeout: 210
        )
    }

    private func decode<T: Decodable>(
        _ type: T.Type,
        path: String,
        method: String = "GET",
        body: Data? = nil,
        additionalHeaders: [String: String] = [:],
        timeout: TimeInterval = 30
    ) async throws -> T {
        let (data, _) = try await perform(
            path: path,
            method: method,
            body: body,
            timeout: timeout,
            additionalHeaders: additionalHeaders
        )
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw APIError(status: 500, code: "invalid_response", message: "The server returned an unreadable response.")
        }
    }

    private func providerOAuthHeaders() throws -> [String: String] {
        guard let providerOAuthCookie else {
            throw APIError(
                status: 400,
                code: "oauth_not_started",
                message: "Start provider sign-in before completing it."
            )
        }
        let cookies = [authority?.cookie, providerOAuthCookie].compactMap { $0 }
        return ["Cookie": cookies.joined(separator: "; ")]
    }

    @discardableResult
    private func perform(
        path: String,
        method: String,
        body: Data?,
        acceptedStatuses: Range<Int> = 200..<300,
        additionallyAcceptedStatus: Int? = nil,
        timeout: TimeInterval = 30,
        additionalHeaders: [String: String] = [:]
    ) async throws -> (Data, HTTPURLResponse) {
        let request = try makeRequest(
            path: path,
            method: method,
            body: body,
            timeout: timeout,
            additionalHeaders: additionalHeaders
        )

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError(status: 0, code: "network_error", message: "The server could not be reached.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, code: "invalid_response", message: "The server returned an invalid response.")
        }
        if let cookie = Self.sessionCookie(from: http), let authority {
            self.authority = Session(
                cookie: cookie,
                orgID: authority.orgID,
                needsOnboarding: authority.needsOnboarding,
                user: authority.user
            )
        }
        guard acceptedStatuses.contains(http.statusCode) || http.statusCode == additionallyAcceptedStatus else {
            let payload = try? decoder.decode(ErrorPayload.self, from: data)
            throw APIError(
                status: http.statusCode,
                code: payload?.code,
                message: payload?.message ?? payload?.error ?? "Request failed with status \(http.statusCode)."
            )
        }
        return (data, http)
    }

    private func makeRequest(
        path: String,
        method: String,
        body: Data?,
        timeout: TimeInterval,
        additionalHeaders: [String: String] = [:]
    ) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError(status: 0, code: "invalid_url", message: "The API address is invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let authority {
            request.setValue(authority.cookie, forHTTPHeaderField: "Cookie")
            if let orgID = authority.orgID {
                request.setValue(orgID, forHTTPHeaderField: "x-companion-org")
            }
        }
        if method != "GET" && method != "HEAD" && additionalHeaders["expo-origin"] == nil {
            request.setValue(
                baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                forHTTPHeaderField: "Origin"
            )
        }
        for (name, value) in additionalHeaders {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    static func sessionCookie(from response: HTTPURLResponse) -> String? {
        if let cookie = cookie(suffix: ".session_token", from: response) {
            return cookie
        }
        guard let header = header(named: "set-cookie", from: response) else { return nil }
        return sessionCookie(fromSetCookieHeader: header)
    }

    static func sessionCookie(fromSetCookieHeader header: String) -> String? {
        header
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .compactMap { value -> String? in
                guard let pair = value.split(separator: ";", maxSplits: 1).first,
                      pair.split(separator: "=", maxSplits: 1).first?.hasSuffix(".session_token") == true else { return nil }
                return String(pair)
            }
            .first
    }

    private static func cookieValue(suffix: String, from response: HTTPURLResponse) -> String? {
        guard let cookie = cookie(suffix: suffix, from: response),
              let separator = cookie.firstIndex(of: "=") else { return nil }
        return String(cookie[cookie.index(after: separator)...])
    }

    private static func cookie(suffix: String, from response: HTTPURLResponse) -> String? {
        var fields: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            guard let key = key as? String else { continue }
            fields[key] = String(describing: value)
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: response.url ?? URL(string: "https://localhost")!)
        if let cookie = cookies.first(where: { $0.name.hasSuffix(suffix) }) {
            return "\(cookie.name)=\(cookie.value)"
        }
        guard let header = header(named: "set-cookie", from: response) else { return nil }
        return header
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .compactMap { value -> String? in
                guard let pair = value.split(separator: ";", maxSplits: 1).first,
                      pair.split(separator: "=", maxSplits: 1).first?.hasSuffix(suffix) == true else { return nil }
                return String(pair)
            }
            .first
    }

    private static func header(named name: String, from response: HTTPURLResponse) -> String? {
        response.allHeaderFields.first { key, _ in
            (key as? String)?.caseInsensitiveCompare(name) == .orderedSame
        }.map { String(describing: $0.value) }
    }
}
