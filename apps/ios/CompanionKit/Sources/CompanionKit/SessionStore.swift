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
    private var notificationInstallationID: UUID?
    private var persistedSession: Session?

    public init(
        apiURL: URL,
        storage: any SessionStorage = KeychainSessionStorage(),
        notificationInstallationID: UUID? = nil
    ) {
        self.client = APIClient(baseURL: apiURL)
        self.storage = storage
        self.notificationInstallationID = notificationInstallationID
    }

    public var currentSession: Session? {
        switch phase {
        case .restoring, .signedOut:
            return nil
        case .onboarding(let session), .active(let session):
            return session
        }
    }

    public var memberTimezone: String? {
        currentSession?.user.timezone
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
        persistedSession = stored
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

    /// Updates the member's shared profile and rolls the returned values into the secure session
    /// snapshot so every first-party surface immediately uses the new timezone/name.
    public func updateUserProfile(
        name: String? = nil,
        timezone: String? = nil
    ) async throws -> UserProfile {
        do {
            let profile = try await client.updateUserProfile(name: name, timezone: timezone)
            if let current = currentSession {
                let updated = Session(
                    cookie: await client.currentAuthority()?.cookie ?? current.cookie,
                    orgID: current.orgID,
                    needsOnboarding: current.needsOnboarding,
                    user: .init(
                        id: profile.id,
                        email: current.user.email,
                        name: profile.name,
                        timezone: profile.timezone
                    )
                )
                await client.setAuthority(updated)
                try? persist(updated)
                publish(updated)
            }
            return profile
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func signOut() async {
        if let notificationInstallationID {
            try? await client.unregisterNotificationDevice(installationID: notificationInstallationID)
        }
        await client.signOut()
        await clearLocalSession()
    }

    public func registerNotificationDevice(
        installationID: UUID,
        registration: NotificationDeviceRegistration
    ) async throws {
        notificationInstallationID = installationID
        do {
            try await client.registerNotificationDevice(
                installationID: installationID,
                registration: registration
            )
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
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

    public func connectedResources(for companion: CompanionSummary) async throws -> CompanionConnectedResources {
        do {
            let resources = try await client.connectedResources(
                companionID: companion.id,
                selectedSkillIDs: companion.selectedSkillIDs
            )
            await persistRollingAuthority()
            return resources
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionRoutines(companionID: String) async throws -> [CompanionRoutine] {
        do {
            let routines = try await client.listCompanionRoutines(companionID: companionID)
            await persistRollingAuthority()
            return routines
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionTriggers(companionID: String) async throws -> [CompanionTrigger] {
        do {
            let triggers = try await client.listCompanionTriggers(companionID: companionID)
            await persistRollingAuthority()
            return triggers
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func createCompanionRoutine(
        companionID: String,
        input: CreateCompanionRoutineInput
    ) async throws -> CompanionRoutine {
        do {
            let routine = try await client.createCompanionRoutine(companionID: companionID, input: input)
            await persistRollingAuthority()
            return routine
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func updateCompanionRoutine(
        companionID: String,
        routineID: String,
        input: UpdateCompanionRoutineInput
    ) async throws -> CompanionRoutine {
        do {
            let routine = try await client.updateCompanionRoutine(
                companionID: companionID,
                routineID: routineID,
                input: input
            )
            await persistRollingAuthority()
            return routine
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanionRoutine(companionID: String, routineID: String) async throws {
        do {
            try await client.deleteCompanionRoutine(companionID: companionID, routineID: routineID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func createCompanionTrigger(
        companionID: String,
        input: CreateCompanionTriggerInput
    ) async throws -> CompanionTrigger {
        do {
            let trigger = try await client.createCompanionTrigger(companionID: companionID, input: input)
            await persistRollingAuthority()
            return trigger
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func updateCompanionTrigger(
        companionID: String,
        triggerID: String,
        input: UpdateCompanionTriggerInput
    ) async throws -> CompanionTrigger {
        do {
            let trigger = try await client.updateCompanionTrigger(
                companionID: companionID,
                triggerID: triggerID,
                input: input
            )
            await persistRollingAuthority()
            return trigger
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanionTrigger(companionID: String, triggerID: String) async throws {
        do {
            try await client.deleteCompanionTrigger(companionID: companionID, triggerID: triggerID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func rotateCompanionTriggerSecret(
        companionID: String,
        triggerID: String
    ) async throws -> CompanionTrigger {
        do {
            let trigger = try await client.rotateCompanionTriggerSecret(
                companionID: companionID,
                triggerID: triggerID
            )
            await persistRollingAuthority()
            return trigger
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

    public func updateCompanion(
        companionID: String,
        input: UpdateCompanionInput
    ) async throws -> CompanionSummary {
        do {
            let companion = try await client.updateCompanion(companionID: companionID, input: input)
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func updateCompanionMemberState(
        companionID: String,
        patch: CompanionMemberStatePatch
    ) async throws -> CompanionSummary {
        do {
            let companion = try await client.updateCompanionMemberState(
                companionID: companionID,
                patch: patch
            )
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func duplicateCompanion(companionID: String) async throws -> CompanionSummary {
        do {
            let companion = try await client.duplicateCompanion(companionID: companionID)
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func updateCompanionPluginSelection(
        companionID: String,
        selectedMCPAccountIDs: [String]
    ) async throws -> CompanionSummary {
        do {
            let companion = try await client.updateCompanionPluginSelection(
                companionID: companionID,
                selectedMCPAccountIDs: selectedMCPAccountIDs
            )
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func companionRuntime(companionID: String) async throws -> CompanionSummary {
        do {
            let companion = try await client.companionRuntime(companionID: companionID)
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func restartCompanion(
        companionID: String,
        target: CompanionRuntimeRestartTarget,
        requestID: UUID
    ) async throws -> CompanionOperationSummary {
        do {
            let operation = try await client.restartCompanion(
                companionID: companionID,
                target: target,
                requestID: requestID
            )
            await persistRollingAuthority()
            return operation
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanion(
        companionID: String,
        requestID: UUID
    ) async throws -> CompanionOperationSummary {
        do {
            let operation = try await client.deleteCompanion(
                companionID: companionID,
                requestID: requestID
            )
            await persistRollingAuthority()
            return operation
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

    public func listAccessibleCompanionSkills() async throws -> [CompanionSkillReference] {
        do {
            let skills = try await client.listAccessibleCompanionSkills()
            await persistRollingAuthority()
            return skills
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

    public func decideCompanionDecision(
        companionID: String,
        requestID: String,
        action: CompanionDecisionAction
    ) async throws -> CompanionThread {
        do {
            let thread = try await client.decideCompanionDecision(
                companionID: companionID,
                requestID: requestID,
                action: action
            )
            await persistRollingAuthority()
            return thread
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func retryCompanionTurn(
        companionID: String,
        turnID: String,
        retryID: UUID
    ) async throws -> CompanionOperationSummary {
        do {
            let operation = try await client.retryCompanionTurn(
                companionID: companionID,
                turnID: turnID,
                retryID: retryID
            )
            await persistRollingAuthority()
            return operation
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func cancelCompanionTurn(
        companionID: String,
        turnID: String
    ) async throws -> CompanionThread {
        do {
            let thread = try await client.cancelCompanionTurn(
                companionID: companionID,
                turnID: turnID
            )
            await persistRollingAuthority()
            return thread
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func sendMessage(
        companionID: String,
        content: String,
        clientMessageID: UUID,
        attachments: [CompanionMessageAttachment] = [],
        uploadProgress: (@Sendable (Double) -> Void)? = nil
    ) async throws {
        do {
            try await client.sendMessage(
                companionID: companionID,
                content: content,
                clientMessageID: clientMessageID,
                attachments: attachments,
                uploadProgress: uploadProgress
            )
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func attachmentData(companionID: String, attachmentID: String) async throws -> Data {
        do {
            let data = try await client.attachmentData(
                companionID: companionID,
                attachmentID: attachmentID
            )
            await persistRollingAuthority()
            return data
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    private func publish(_ session: Session) {
        let nextPhase = session.needsOnboarding ? Phase.onboarding(session) : .active(session)
        guard phase != nextPhase else { return }
        phase = nextPhase
    }

    private func persist(_ session: Session) throws {
        try storage.save(encoder.encode(session))
        persistedSession = session
    }

    private func persistRollingAuthority() async {
        guard let authority = await client.currentAuthority() else { return }
        if persistedSession != authority {
            try? persist(authority)
        }
        publish(authority)
    }

    private func clearLocalSession() async {
        try? storage.remove()
        persistedSession = nil
        await client.setAuthority(nil)
        bootstrapError = nil
        phase = .signedOut
    }
}
