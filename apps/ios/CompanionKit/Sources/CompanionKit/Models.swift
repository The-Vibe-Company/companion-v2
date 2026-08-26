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

/// The minimal Skills Hub projection needed to name a resource in a Companion decision card.
public struct CompanionSkillReference: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let slug: String
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

public enum CompanionDecisionKind: String, Codable, Equatable, Sendable {
    case shell
    case file
    case question
    case config
    case routine
    case trigger
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionDecisionStatus: String, Codable, Equatable, Sendable {
    case pending
    case allowed
    case denied
    case answered
    case expired
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct CompanionConfigProposal: Codable, Equatable, Sendable {
    public struct PluginConnection: Codable, Equatable, Sendable {
        public let serverName: String
        public let reason: String?

        enum CodingKeys: String, CodingKey {
            case serverName = "server_name"
            case reason
        }
    }

    public let addSkillIDs: [String]
    public let removeSkillIDs: [String]
    public let attachPluginIDs: [String]
    public let detachPluginIDs: [String]
    public let modelID: String?
    public let persona: String?
    public let includesPersona: Bool
    public let connectPlugin: PluginConnection?

    enum CodingKeys: String, CodingKey {
        case kind
        case addSkillIDs = "add_skill_ids"
        case removeSkillIDs = "remove_skill_ids"
        case attachPluginIDs = "attach_plugin_ids"
        case detachPluginIDs = "detach_plugin_ids"
        case modelID = "model_id"
        case persona
        case connectPlugin = "connect_plugin"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        addSkillIDs = try container.decodeIfPresent([String].self, forKey: .addSkillIDs) ?? []
        removeSkillIDs = try container.decodeIfPresent([String].self, forKey: .removeSkillIDs) ?? []
        attachPluginIDs = try container.decodeIfPresent([String].self, forKey: .attachPluginIDs) ?? []
        detachPluginIDs = try container.decodeIfPresent([String].self, forKey: .detachPluginIDs) ?? []
        modelID = try container.decodeIfPresent(String.self, forKey: .modelID)
        includesPersona = container.contains(.persona)
        persona = try container.decodeIfPresent(String.self, forKey: .persona)
        connectPlugin = try container.decodeIfPresent(PluginConnection.self, forKey: .connectPlugin)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("config", forKey: .kind)
        if !addSkillIDs.isEmpty { try container.encode(addSkillIDs, forKey: .addSkillIDs) }
        if !removeSkillIDs.isEmpty { try container.encode(removeSkillIDs, forKey: .removeSkillIDs) }
        if !attachPluginIDs.isEmpty { try container.encode(attachPluginIDs, forKey: .attachPluginIDs) }
        if !detachPluginIDs.isEmpty { try container.encode(detachPluginIDs, forKey: .detachPluginIDs) }
        try container.encodeIfPresent(modelID, forKey: .modelID)
        if includesPersona {
            if let persona {
                try container.encode(persona, forKey: .persona)
            } else {
                try container.encodeNil(forKey: .persona)
            }
        }
        try container.encodeIfPresent(connectPlugin, forKey: .connectPlugin)
    }
}

public struct CompanionRoutineProposal: Codable, Equatable, Sendable {
    public let name: String
    public let prompt: String
    public let cron: String
    public let timezone: String

    enum CodingKeys: String, CodingKey {
        case kind
        case name
        case prompt
        case cron
        case timezone
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        prompt = try container.decode(String.self, forKey: .prompt)
        cron = try container.decode(String.self, forKey: .cron)
        timezone = try container.decode(String.self, forKey: .timezone)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("routine", forKey: .kind)
        try container.encode(name, forKey: .name)
        try container.encode(prompt, forKey: .prompt)
        try container.encode(cron, forKey: .cron)
        try container.encode(timezone, forKey: .timezone)
    }
}

public struct CompanionTriggerProposal: Codable, Equatable, Sendable {
    public struct Target: Codable, Equatable, Sendable {
        public let repo: String?
        public let events: [String]?
    }

    public let name: String
    public let prompt: String
    public let provider: String
    public let target: Target?

    enum CodingKeys: String, CodingKey {
        case kind
        case name
        case prompt
        case provider
        case target
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        prompt = try container.decode(String.self, forKey: .prompt)
        provider = try container.decode(String.self, forKey: .provider)
        target = try container.decodeIfPresent(Target.self, forKey: .target)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("trigger", forKey: .kind)
        try container.encode(name, forKey: .name)
        try container.encode(prompt, forKey: .prompt)
        try container.encode(provider, forKey: .provider)
        try container.encodeIfPresent(target, forKey: .target)
    }
}

public enum CompanionDecisionProposal: Codable, Equatable, Sendable {
    case config(CompanionConfigProposal)
    case routine(CompanionRoutineProposal)
    case trigger(CompanionTriggerProposal)

    private enum CodingKeys: String, CodingKey {
        case kind
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "config": self = .config(try CompanionConfigProposal(from: decoder))
        case "routine": self = .routine(try CompanionRoutineProposal(from: decoder))
        case "trigger": self = .trigger(try CompanionTriggerProposal(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unsupported Companion decision proposal"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .config(let proposal): try proposal.encode(to: encoder)
        case .routine(let proposal): try proposal.encode(to: encoder)
        case .trigger(let proposal): try proposal.encode(to: encoder)
        }
    }
}

public struct CompanionDecision: Codable, Equatable, Sendable {
    public let requestID: String
    public let kind: CompanionDecisionKind
    public let name: String
    public let title: String
    public let detail: String?
    public let status: CompanionDecisionStatus
    public let answer: String?
    public let decidedByID: String?
    public let decidedByName: String?
    public let decidedAt: String?
    public let expiresAt: String
    public let proposal: CompanionDecisionProposal?

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case kind
        case name
        case title
        case detail
        case status
        case answer
        case decidedByID = "decided_by_id"
        case decidedByName = "decided_by_name"
        case decidedAt = "decided_at"
        case expiresAt = "expires_at"
        case proposal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestID = try container.decode(String.self, forKey: .requestID)
        kind = try container.decode(CompanionDecisionKind.self, forKey: .kind)
        name = try container.decode(String.self, forKey: .name)
        title = try container.decode(String.self, forKey: .title)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        status = try container.decode(CompanionDecisionStatus.self, forKey: .status)
        answer = try container.decodeIfPresent(String.self, forKey: .answer)
        decidedByID = try container.decodeIfPresent(String.self, forKey: .decidedByID)
        decidedByName = try container.decodeIfPresent(String.self, forKey: .decidedByName)
        decidedAt = try container.decodeIfPresent(String.self, forKey: .decidedAt)
        expiresAt = try container.decode(String.self, forKey: .expiresAt)
        proposal = kind == .unknown
            ? nil
            : try container.decodeIfPresent(CompanionDecisionProposal.self, forKey: .proposal)
    }
}

public enum CompanionDecisionAction: Encodable, Equatable, Sendable {
    case allow
    case deny
    case answer(String)

    private enum CodingKeys: String, CodingKey {
        case action
        case answer
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .allow:
            try container.encode("allow", forKey: .action)
        case .deny:
            try container.encode("deny", forKey: .action)
        case .answer(let answer):
            try container.encode("answer", forKey: .action)
            try container.encode(answer, forKey: .answer)
        }
    }
}

public enum CompanionToolRunKind: String, Codable, Hashable, Sendable {
    case shell
    case file
    case browse
    case computer
    case subagent
    case tool

    /// The server keeps the catalog open for rolling deploys. A newer runtime may write a kind
    /// this client does not know yet; keep the transcript readable with the generic tool family.
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .tool
    }
}

public enum CompanionToolRunStatus: String, Codable, Hashable, Sendable {
    case running
    case ok
    case error
    case timeout
}

public struct CompanionToolRun: Codable, Equatable, Hashable, Sendable {
    public let callID: String?
    public let kind: CompanionToolRunKind
    public let name: String
    public let title: String
    public let status: CompanionToolRunStatus
    public let detail: String?
    public let screenshot: String?

    public init(
        callID: String?,
        kind: CompanionToolRunKind,
        name: String,
        title: String,
        status: CompanionToolRunStatus,
        detail: String?,
        screenshot: String?
    ) {
        self.callID = callID
        self.kind = kind
        self.name = name
        self.title = title
        self.status = status
        self.detail = detail
        self.screenshot = screenshot
    }

    enum CodingKeys: String, CodingKey {
        case callID = "call_id"
        case kind
        case name
        case title
        case status
        case detail
        case screenshot
    }
}

public struct TranscriptEntry: Codable, Identifiable, Equatable, Sendable {
    public let eventID: String
    public let ordinal: Int
    public let role: String
    public let content: String
    public let authorID: String?
    public let authorName: String?
    public let decision: CompanionDecision?
    public let tool: CompanionToolRun?
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
        case decision
        case tool
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
