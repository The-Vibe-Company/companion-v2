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
        case hidden
        case unread
        case lastMessage = "last_message"
        case runtime
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
