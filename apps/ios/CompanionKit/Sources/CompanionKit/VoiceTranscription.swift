import Foundation

public let companionTranscriptionAudioMaximumBytes = 8 * 1024 * 1024

public struct CompanionTranscription: Codable, Equatable, Sendable {
    public let transcript: String

    public init(transcript: String) {
        self.transcript = transcript
    }
}

public enum CompanionTranscriptionError: Error, LocalizedError, Equatable, Sendable {
    case emptyAudio
    case audioTooLarge

    public var errorDescription: String? {
        switch self {
        case .emptyAudio:
            "The recording is empty. Try again."
        case .audioTooLarge:
            "The recording is too long. Try a shorter message."
        }
    }
}
