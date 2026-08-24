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

public struct CompanionSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let persona: String?
    public let modelID: String?
    public let icon: Icon?
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

        enum CodingKeys: String, CodingKey {
            case state
            case replying
            case lastError = "last_error"
        }
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case persona
        case modelID = "model_id"
        case icon
        case hidden
        case unread
        case lastMessage = "last_message"
        case runtime
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
