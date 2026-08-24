import Foundation
import Observation
import Security

public protocol SessionStorage: Sendable {
    func load() throws -> Data?
    func save(_ data: Data) throws
    func remove() throws
}

public struct KeychainSessionStorage: SessionStorage {
    private let service: String
    private let account = "primary"

    public init(service: String = "dev.companion.mobile.session") {
        self.service = service
    }

    public func load() throws -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw StorageError(status: status) }
        return data
    }

    public func save(_ data: Data) throws {
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw StorageError(status: updateStatus) }
        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw StorageError(status: addStatus) }
    }

    public func remove() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StorageError(status: status) }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private struct StorageError: Error {
        let status: OSStatus
    }
}

@MainActor
@Observable
public final class SessionStore {
    public enum Phase: Equatable, Sendable {
        case restoring
        case signedOut
        case onboarding(Session)
        case active(Session)
    }

    public private(set) var phase: Phase = .restoring
    public private(set) var bootstrapError: String?

    private let client: APIClient
    private let storage: any SessionStorage
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var restored = false

    public init(apiURL: URL, storage: any SessionStorage = KeychainSessionStorage()) {
        self.client = APIClient(baseURL: apiURL)
        self.storage = storage
    }

    public func restore() async {
        guard !restored else { return }
        restored = true
        phase = .restoring
        bootstrapError = nil
        let data: Data?
        do {
            data = try storage.load()
        } catch {
            phase = .signedOut
            bootstrapError = "Secure storage is temporarily unavailable."
            return
        }
        guard let data else {
            phase = .signedOut
            return
        }
        guard let stored = try? decoder.decode(Session.self, from: data), !stored.cookie.isEmpty else {
            try? storage.remove()
            phase = .signedOut
            return
        }
        await client.setAuthority(stored)
        publish(stored)
        do {
            let identity = try await client.whoAmI()
            let refreshed = Session(cookie: await client.currentAuthority()?.cookie ?? stored.cookie, identity: identity)
            await client.setAuthority(refreshed)
            try? persist(refreshed)
            publish(refreshed)
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
        } catch {
            // Keep the last known-good authority on retryable network and server failures.
        }
    }

    public func retryRestore() async {
        restored = false
        await restore()
    }

    public func signIn(email: String, password: String) async throws {
        let authenticated = try await client.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
        try persist(authenticated)
        publish(authenticated)
    }

    public func beginGoogleSignIn(callbackScheme: String) async throws -> APIClient.GoogleAuthorization {
        try await client.beginGoogleSignIn(callbackScheme: callbackScheme)
    }

    public func completeGoogleSignIn(callbackURL: URL) async throws {
        let authenticated = try await client.completeGoogleSignIn(callbackURL: callbackURL)
        try persist(authenticated)
        publish(authenticated)
    }

    public func signOut() async {
        await client.signOut()
        await clearLocalSession()
    }

    public func listCompanions() async throws -> [CompanionSummary] {
        do {
            let companions = try await client.listCompanions()
            await persistRollingAuthority()
            return companions
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func createCompanion(_ input: CreateCompanionInput) async throws -> CompanionSummary {
        do {
            let companion = try await client.createCompanion(input)
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionProviders() async throws -> CompanionProvidersResponse {
        do {
            let providers = try await client.listCompanionProviders()
            await persistRollingAuthority()
            return providers
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func saveCompanionProvider(
        providerID: String,
        credential: String
    ) async throws -> CompanionProviderConnection {
        do {
            let connection = try await client.saveCompanionProvider(
                providerID: providerID,
                credential: credential
            )
            await persistRollingAuthority()
            return connection
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func setDefaultCompanionProvider(providerID: String) async throws {
        do {
            try await client.setDefaultCompanionProvider(providerID: providerID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanionProvider(providerID: String) async throws {
        do {
            try await client.deleteCompanionProvider(providerID: providerID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func startCompanionProviderOAuth(
        providerID: String
    ) async throws -> CompanionProviderOAuthStart {
        do {
            let flow = try await client.startCompanionProviderOAuth(providerID: providerID)
            await persistRollingAuthority()
            return flow
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func completeCompanionProviderOAuth(
        authorizationCode: String
    ) async throws -> CompanionProviderConnection {
        do {
            let connection = try await client.completeCompanionProviderOAuth(
                authorizationCode: authorizationCode
            )
            await persistRollingAuthority()
            return connection
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func pollCompanionProviderOAuth() async throws -> CompanionProviderOAuthPoll {
        do {
            let result = try await client.pollCompanionProviderOAuth()
            await persistRollingAuthority()
            return result
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func cancelCompanionProviderOAuth() async {
        await client.cancelCompanionProviderOAuth()
    }

    public func listCompanionPlugins() async throws -> [CompanionPluginAccount] {
        do {
            let plugins = try await client.listCompanionPlugins()
            await persistRollingAuthority()
            return plugins
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func saveCompanionPlugin(
        _ input: SaveCompanionPluginInput
    ) async throws -> CompanionPluginAccount {
        do {
            let plugin = try await client.saveCompanionPlugin(input)
            await persistRollingAuthority()
            return plugin
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func companionPluginOAuthRequest(
        serverName: String,
        label: String
    ) async throws -> URLRequest {
        do {
            return try await client.companionPluginOAuthRequest(
                serverName: serverName,
                label: label
            )
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanionPlugin(accountID: String) async throws {
        do {
            try await client.deleteCompanionPlugin(accountID: accountID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func thread(companionID: String) async throws -> CompanionThread {
        do {
            let thread = try await client.thread(companionID: companionID)
            await persistRollingAuthority()
            return thread
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func sendMessage(companionID: String, content: String, clientMessageID: UUID) async throws {
        do {
            try await client.sendMessage(companionID: companionID, content: content, clientMessageID: clientMessageID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    private func publish(_ session: Session) {
        phase = session.needsOnboarding ? .onboarding(session) : .active(session)
    }

    private func persist(_ session: Session) throws {
        try storage.save(encoder.encode(session))
    }

    private func persistRollingAuthority() async {
        guard let authority = await client.currentAuthority() else { return }
        try? persist(authority)
        publish(authority)
    }

    private func clearLocalSession() async {
        try? storage.remove()
        await client.setAuthority(nil)
        bootstrapError = nil
        phase = .signedOut
    }
}
