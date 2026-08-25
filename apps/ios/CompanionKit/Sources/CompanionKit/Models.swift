import Foundation

public struct WorkspaceIdentity: Codable, Equatable, Sendable {
    public let id: String
    public let name: String

    enum CodingKeys: String, CodingKey {
        case id = "org_id"
        case name
    }
}

public struct WhoAmI: Codable, Equatable, Sendable {
    public let userID: String
    public let email: String
    public let name: String?
    public let org: WorkspaceIdentity?
    public let onboarded: Bool
    public let needsOnboarding: Bool

    enum CodingKeys: String, CodingKey {
        case userID = "userId"
        case email
        case name
        case org
        case onboarded
        case needsOnboarding
    }
}

public struct Session: Codable, Equatable, Sendable {
    public let cookie: String
    public let orgID: String?
    public let needsOnboarding: Bool
    public let user: User

    public struct User: Codable, Equatable, Sendable {
        public let id: String
        public let email: String
        public let name: String?

        public init(id: String, email: String, name: String?) {
            self.id = id
            self.email = email
            self.name = name
        }
    }

    public init(cookie: String, orgID: String?, needsOnboarding: Bool, user: User) {
        self.cookie = cookie
        self.orgID = orgID
        self.needsOnboarding = needsOnboarding
        self.user = user
    }

    public init(cookie: String, identity: WhoAmI) {
        self.init(
            cookie: cookie,
            orgID: identity.org?.id,
            needsOnboarding: identity.needsOnboarding || identity.org == nil,
            user: User(id: identity.userID, email: identity.email, name: identity.name)
        )
    }
}

public enum CompanionNotificationEvent: String, Codable, Equatable, Sendable {
    case reply
    case inputRequired = "input_required"
    case failed
    case interrupted
}

public struct CompanionNotificationPayload: Codable, Equatable, Sendable {
    public let version: Int
    public let orgID: String
    public let companionID: String
    public let event: CompanionNotificationEvent

    public init(version: Int, orgID: String, companionID: String, event: CompanionNotificationEvent) {
        self.version = version
        self.orgID = orgID
        self.companionID = companionID
        self.event = event
    }

    enum CodingKeys: String, CodingKey {
        case version
        case orgID = "org_id"
        case companionID = "companion_id"
        case event
    }
}

public struct NotificationDeviceRegistration: Codable, Equatable, Sendable {
    public enum Environment: String, Codable, Equatable, Sendable {
        case sandbox
        case production
    }

    public let platform = "ios"
    public let deviceToken: String
    public let environment: Environment
    public let bundleID: String

    public init(deviceToken: String, environment: Environment, bundleID: String) {
        self.deviceToken = deviceToken
        self.environment = environment
        self.bundleID = bundleID
    }

    enum CodingKeys: String, CodingKey {
        case platform
        case deviceToken = "device_token"
        case environment
        case bundleID = "bundle_id"
    }
}

public enum NotificationInstallationIdentifier {
    public static func current(bundleIdentifier: String) -> UUID {
        let key = "dev.companion.notification-installation.\(bundleIdentifier)"
        if let value = UserDefaults.standard.string(forKey: key), let identifier = UUID(uuidString: value) {
            return identifier
        }
        let identifier = UUID()
        UserDefaults.standard.set(identifier.uuidString.lowercased(), forKey: key)
        return identifier
    }
}

public enum CompanionRuntimeState: String, Codable, Hashable, Sendable {
    case notCreated = "not_created"
    case provisioning
    case running
    case stopping
    case stopped
    case error
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionAccess: String, Codable, Hashable, Sendable {
    case owner
    case editor
    case viewer

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .viewer
    }

    public var canEditCompanionSettings: Bool {
        self == .owner || self == .editor
    }

    public var canDeleteCompanion: Bool {
        self == .owner
    }
}

public enum CompanionOperationKind: String, Codable, Hashable, Sendable {
    case delete
    case stop
    case restartPi = "restart_pi"
    case restartBox = "restart_box"
    case start
    case applySettings = "apply_settings"
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionOperationStatus: String, Codable, Hashable, Sendable {
    case pending
    case running
    case succeeded
    case failed
    case interrupted
    case cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct CompanionRuntimeSafeError: Codable, Hashable, Sendable {
    public let code: String
    public let message: String
    public let action: String
}

public struct CompanionOperationSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let kind: CompanionOperationKind
    public let status: CompanionOperationStatus
    public let error: CompanionRuntimeSafeError?

    public var isActive: Bool {
        status == .pending || status == .running
    }
}

public struct CompanionSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let persona: String?
    public let modelID: String?
    public let icon: Icon?
    public let access: CompanionAccess
    public let hidden: Bool
    public let unread: Bool
    public let lastMessage: LastMessage?
    public let runtime: Runtime

    public struct LastMessage: Codable, Hashable, Sendable {
        public let preview: String
        public let role: String
        public let createdAt: String

        enum CodingKeys: String, CodingKey {
            case preview
            case role
            case createdAt = "created_at"
        }
    }

    public struct Icon: Codable, Hashable, Sendable {
        public let shape: Int
        public let mouth: Int
        public let accessory: Int
        public let color: Int

        public init(shape: Int, mouth: Int, accessory: Int, color: Int) {
            self.shape = shape
            self.mouth = mouth
            self.accessory = accessory
            self.color = color
        }
    }

    public struct Runtime: Codable, Hashable, Sendable {
        public let state: CompanionRuntimeState
        public let replying: Bool
        public let lastError: String?
        public let providerIDs: [String]
        public let latestOperation: CompanionOperationSummary?

        enum CodingKeys: String, CodingKey {
            case state
            case replying
            case lastError = "last_error"
            case providerIDs = "provider_ids"
            case latestOperation = "latest_operation"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            state = try container.decode(CompanionRuntimeState.self, forKey: .state)
            replying = try container.decodeIfPresent(Bool.self, forKey: .replying) ?? false
            lastError = try container.decodeIfPresent(String.self, forKey: .lastError)
            providerIDs = try container.decodeIfPresent([String].self, forKey: .providerIDs) ?? []
            latestOperation = try container.decodeIfPresent(
                CompanionOperationSummary.self,
                forKey: .latestOperation
            )
        }
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case persona
        case modelID = "model_id"
        case icon
        case access
        case hidden
        case unread
        case lastMessage = "last_message"
        case runtime
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        persona = try container.decodeIfPresent(String.self, forKey: .persona)
        modelID = try container.decodeIfPresent(String.self, forKey: .modelID)
        icon = try container.decodeIfPresent(Icon.self, forKey: .icon)
        access = try container.decodeIfPresent(CompanionAccess.self, forKey: .access) ?? .viewer
        hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
        unread = try container.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        lastMessage = try container.decodeIfPresent(LastMessage.self, forKey: .lastMessage)
        runtime = try container.decode(Runtime.self, forKey: .runtime)
    }

    public var deletionOperation: CompanionOperationSummary? {
        guard runtime.latestOperation?.kind == .delete else { return nil }
        return runtime.latestOperation
    }

    public func preservingListProjection(from previous: CompanionSummary) -> CompanionSummary {
        CompanionSummary(
            id: id,
            name: name,
            persona: persona,
            modelID: modelID,
            icon: icon,
            access: access,
            hidden: hidden,
            unread: unread,
            lastMessage: lastMessage ?? previous.lastMessage,
            runtime: runtime
        )
    }

    private init(
        id: String,
        name: String,
        persona: String?,
        modelID: String?,
        icon: Icon?,
        access: CompanionAccess,
        hidden: Bool,
        unread: Bool,
        lastMessage: LastMessage?,
        runtime: Runtime
    ) {
        self.id = id
        self.name = name
        self.persona = persona
        self.modelID = modelID
        self.icon = icon
        self.access = access
        self.hidden = hidden
        self.unread = unread
        self.lastMessage = lastMessage
        self.runtime = runtime
    }
}

public enum CompanionProviderAuthMethod: String, Codable, Hashable, Sendable {
    case apiKey = "api_key"
    case subscription
}

public struct CompanionProviderDefinition: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let authMethods: [CompanionProviderAuthMethod]
    public let description: String
    public let models: [Model]

    public struct Model: Codable, Identifiable, Hashable, Sendable {
        public let id: String
        public let name: String
        public let isDefault: Bool?
        public let input: [String]?

        enum CodingKeys: String, CodingKey {
            case id
            case name
            case isDefault = "default"
            case input
        }
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case authMethods = "auth_methods"
        case description
        case models
    }

    public var defaultModelID: String? {
        models.first(where: { $0.isDefault == true })?.id ?? models.first?.id
    }
}

public struct CompanionProviderConnection: Codable, Identifiable, Hashable, Sendable {
    public let providerID: String
    public let authMethod: CompanionProviderAuthMethod
    public let connectedBy: String?
    public let createdAt: String
    public let updatedAt: String

    public var id: String { providerID }

    enum CodingKeys: String, CodingKey {
        case providerID = "provider_id"
        case authMethod = "auth_method"
        case connectedBy = "connected_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct CompanionProvidersResponse: Codable, Equatable, Sendable {
    public let catalog: [CompanionProviderDefinition]
    public let connections: [CompanionProviderConnection]
    public let defaultProviderID: String?
    public let canManage: Bool

    enum CodingKeys: String, CodingKey {
        case catalog
        case connections
        case defaultProviderID = "default_provider_id"
        case canManage = "can_manage"
    }

    public init(
        catalog: [CompanionProviderDefinition],
        connections: [CompanionProviderConnection],
        defaultProviderID: String?,
        canManage: Bool
    ) {
        self.catalog = catalog
        self.connections = connections
        self.defaultProviderID = defaultProviderID
        self.canManage = canManage
    }

    public var connectedDefinitions: [CompanionProviderDefinition] {
        let connected = Set(connections.map(\.providerID))
        return catalog.filter { connected.contains($0.id) }
    }
}

public struct CompanionProviderOAuthStart: Codable, Equatable, Sendable {
    public enum Flow: String, Codable, Sendable {
        case authorizationCode = "authorization_code"
        case deviceCode = "device_code"
    }

    public let flow: Flow
    public let providerID: String
    public let authorizationURL: URL?
    public let verificationURL: URL?
    public let userCode: String?
    public let pollIntervalSeconds: Int?
    public let expiresAt: String?

    enum CodingKeys: String, CodingKey {
        case flow
        case providerID = "provider_id"
        case authorizationURL = "authorization_url"
        case verificationURL = "verification_url"
        case userCode = "user_code"
        case pollIntervalSeconds = "poll_interval_seconds"
        case expiresAt = "expires_at"
    }
}

public struct CompanionProviderOAuthPoll: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case pending
        case connected
    }

    public let status: Status
    public let connection: CompanionProviderConnection?
}

public enum CompanionPluginTransport: String, Codable, Hashable, Sendable {
    case http
    case stdio
}

public struct CompanionPluginAccount: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let provider: String
    public let label: String
    public let transport: CompanionPluginTransport
    public let endpoint: String
    public let connected: Bool
    public let createdAt: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case provider
        case label
        case transport
        case endpoint
        case connected
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct CreateCompanionInput: Encodable, Equatable, Sendable {
    public let name: String
    public let persona: String?
    public let providerID: String
    public let modelID: String
    public let selectedSkillIDs: [String]
    public let selectedMCPAccountIDs: [String]
    public let icon: CompanionSummary.Icon

    public init(
        name: String,
        persona: String? = nil,
        providerID: String,
        modelID: String,
        selectedSkillIDs: [String] = [],
        selectedMCPAccountIDs: [String] = [],
        icon: CompanionSummary.Icon
    ) {
        self.name = name
        self.persona = persona
        self.providerID = providerID
        self.modelID = modelID
        self.selectedSkillIDs = selectedSkillIDs
        self.selectedMCPAccountIDs = selectedMCPAccountIDs
        self.icon = icon
    }

    enum CodingKeys: String, CodingKey {
        case name
        case persona
        case providerID = "provider_id"
        case modelID = "model_id"
        case selectedSkillIDs = "selected_skill_ids"
        case selectedMCPAccountIDs = "selected_mcp_account_ids"
        case icon
    }
}

public struct UpdateCompanionInput: Encodable, Equatable, Sendable {
    public let name: String
    public let persona: String?
    public let providerID: String
    public let modelID: String
    public let icon: CompanionSummary.Icon

    public init(
        name: String,
        persona: String?,
        providerID: String,
        modelID: String,
        icon: CompanionSummary.Icon
    ) {
        self.name = name
        self.persona = persona
        self.providerID = providerID
        self.modelID = modelID
        self.icon = icon
    }

    enum CodingKeys: String, CodingKey {
        case name
        case persona
        case providerID = "provider_id"
        case modelID = "model_id"
        case icon
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        if let persona {
            try container.encode(persona, forKey: .persona)
        } else {
            try container.encodeNil(forKey: .persona)
        }
        try container.encode(providerID, forKey: .providerID)
        try container.encode(modelID, forKey: .modelID)
        try container.encode(icon, forKey: .icon)
    }
}

public struct SaveCompanionPluginInput: Encodable, Equatable, Sendable {
    public let provider: String
    public let label: String
    public let transport: CompanionPluginTransport
    public let url: String?
    public let command: String?
    public let args: [String]
    public let credentialName: String?
    public let credentialValue: String?

    public init(
        provider: String,
        label: String,
        transport: CompanionPluginTransport,
        url: String? = nil,
        command: String? = nil,
        args: [String] = [],
        credentialName: String? = nil,
        credentialValue: String? = nil
    ) {
        self.provider = provider
        self.label = label
        self.transport = transport
        self.url = url
        self.command = command
        self.args = args
        self.credentialName = credentialName
        self.credentialValue = credentialValue
    }

    enum CodingKeys: String, CodingKey {
        case provider
        case label
        case transport
        case url
        case command
        case args
        case credentialName = "credential_name"
        case credentialValue = "credential_value"
    }
}

public struct TranscriptEntry: Codable, Identifiable, Equatable, Sendable {
    public let eventID: String
    public let ordinal: Int
    public let role: String
    public let content: String
    public let authorID: String?
    public let authorName: String?
    public let queued: Bool
    public let createdAt: String

    public var id: String { eventID }

    enum CodingKeys: String, CodingKey {
        case eventID = "event_id"
        case ordinal
        case role
        case content
        case authorID = "author_id"
        case authorName = "author_name"
        case queued
        case createdAt = "created_at"
    }
}

public struct CompanionThread: Codable, Equatable, Sendable {
    public let companionID: String
    public let viewerID: String
    public let readOnly: Bool
    public let canSend: Bool
    public let entries: [TranscriptEntry]
    public let queuedCount: Int

    enum CodingKeys: String, CodingKey {
        case companionID = "companion_id"
        case viewerID = "viewer_id"
        case readOnly = "read_only"
        case canSend = "can_send"
        case entries
        case queuedCount = "queued_count"
    }
}
