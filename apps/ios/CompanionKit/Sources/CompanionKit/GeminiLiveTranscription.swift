import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct CompanionTranscriptionSession: Codable, Equatable, Sendable {
    public let token: String
    public let expiresAt: String
    public let model: String

    public init(token: String, expiresAt: String, model: String) {
        self.token = token
        self.expiresAt = expiresAt
        self.model = model
    }

    private enum CodingKeys: String, CodingKey {
        case token
        case expiresAt = "expires_at"
        case model
    }
}

public enum GeminiLiveTranscriptionEvent: Equatable, Sendable {
    case ready
    case reconnecting
    case interim(String)
    case final(String)
    case completed
}

public enum GeminiLiveTranscriptionError: Error, LocalizedError, Equatable, Sendable {
    case missingToken
    case alreadyConnected
    case notConnected
    case invalidAudio
    case connectionTimedOut
    case responseTimedOut
    case connectionLost
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .missingToken:
            "Transcription could not start because its secure session was missing."
        case .alreadyConnected:
            "Transcription is already active."
        case .notConnected:
            "Transcription is not connected."
        case .invalidAudio:
            "The microphone produced an unsupported audio frame."
        case .connectionTimedOut:
            "Google transcription took too long to connect. Try again."
        case .responseTimedOut:
            "Google transcription did not finish in time. Try again."
        case .connectionLost:
            "The connection to Google transcription was lost."
        case .invalidResponse:
            "Google transcription returned an unreadable response."
        }
    }
}

public enum GeminiLiveWebSocketMessage: Equatable, Sendable {
    case data(Data)
    case string(String)
}

public protocol GeminiLiveWebSocket: Sendable {
    func resume() async
    func send(_ data: Data) async throws
    func receive() async throws -> GeminiLiveWebSocketMessage
    func cancel() async
}

public struct GeminiLiveWebSocketFactory: Sendable {
    private let makeSocket: @Sendable (URL) -> any GeminiLiveWebSocket

    public init(makeSocket: @escaping @Sendable (URL) -> any GeminiLiveWebSocket) {
        self.makeSocket = makeSocket
    }

    public func socket(for url: URL) -> any GeminiLiveWebSocket {
        makeSocket(url)
    }

    public static func urlSession(_ session: URLSession = .shared) -> Self {
        Self { url in
            URLSessionGeminiLiveWebSocket(task: session.webSocketTask(with: url))
        }
    }
}

private actor URLSessionGeminiLiveWebSocket: GeminiLiveWebSocket {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func resume() {
        task.resume()
    }

    func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    func receive() async throws -> GeminiLiveWebSocketMessage {
        switch try await task.receive() {
        case .data(let data):
            return .data(data)
        case .string(let string):
            return .string(string)
        @unknown default:
            throw GeminiLiveTranscriptionError.invalidResponse
        }
    }

    func cancel() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

public actor GeminiLiveTranscriptionClient {
    public static let model = "gemini-3.5-transcribe-live"
    public static let audioMIMEType = "audio/pcm;rate=16000"

    private static let endpoint = URL(
        string: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
    )!
    private static let maximumBufferedFrames = 10

    private let factory: GeminiLiveWebSocketFactory
    private let connectionTimeout: Duration
    private let completionTimeout: Duration
    private var socket: (any GeminiLiveWebSocket)?
    private var continuation: AsyncThrowingStream<GeminiLiveTranscriptionEvent, Error>.Continuation?
    private var receiveTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var token: String?
    private var resumptionHandle: String?
    private var generation = 0
    private var reconnectAttempts = 0
    private var isReady = false
    private var isReconnecting = false
    private var isFinishing = false
    private var bufferedAudio: [Data] = []

    public init(
        factory: GeminiLiveWebSocketFactory = .urlSession(),
        connectionTimeout: Duration = .seconds(10),
        completionTimeout: Duration = .seconds(5)
    ) {
        self.factory = factory
        self.connectionTimeout = connectionTimeout
        self.completionTimeout = completionTimeout
    }

    public func connect(
        token: String
    ) async throws -> AsyncThrowingStream<GeminiLiveTranscriptionEvent, Error> {
        guard self.token == nil else { throw GeminiLiveTranscriptionError.alreadyConnected }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else { throw GeminiLiveTranscriptionError.missingToken }

        let (stream, continuation) = AsyncThrowingStream<GeminiLiveTranscriptionEvent, Error>.makeStream()
        self.continuation = continuation
        self.token = trimmedToken
        do {
            try await openSocket(resumingWith: nil)
        } catch {
            await finish(error: nil)
            throw error
        }
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
        return stream
    }

    public func sendPCM16(_ data: Data) async throws {
        guard !data.isEmpty, data.count.isMultiple(of: 2) else {
            throw GeminiLiveTranscriptionError.invalidAudio
        }
        guard token != nil, !isFinishing else {
            throw GeminiLiveTranscriptionError.notConnected
        }
        if isReconnecting {
            guard bufferedAudio.count < Self.maximumBufferedFrames else {
                throw GeminiLiveTranscriptionError.connectionLost
            }
            bufferedAudio.append(data)
            return
        }
        guard isReady, let socket else {
            throw GeminiLiveTranscriptionError.notConnected
        }
        do {
            try await sendAudio(data, over: socket)
        } catch {
            throw GeminiLiveTranscriptionError.connectionLost
        }
    }

    public func finishAudio() async throws {
        guard token != nil, !isFinishing else {
            throw GeminiLiveTranscriptionError.notConnected
        }
        isFinishing = true
        if isReconnecting { return }
        guard isReady, let socket else {
            isFinishing = false
            throw GeminiLiveTranscriptionError.notConnected
        }
        do {
            try await sendAudioStreamEnd(over: socket)
        } catch {
            isFinishing = false
            throw GeminiLiveTranscriptionError.connectionLost
        }
    }

    public func close() async {
        await finish(error: nil)
    }

    private func openSocket(resumingWith handle: String?) async throws {
        guard let token, var components = URLComponents(url: Self.endpoint, resolvingAgainstBaseURL: false) else {
            throw GeminiLiveTranscriptionError.missingToken
        }
        components.queryItems = [URLQueryItem(name: "access_token", value: token)]
        guard let url = components.url else { throw GeminiLiveTranscriptionError.missingToken }

        generation &+= 1
        let nextSocket = factory.socket(for: url)
        socket = nextSocket
        isReady = false
        await nextSocket.resume()
        do {
            try await nextSocket.send(try Self.encoded(SetupEnvelope(
                setup: .init(
                    model: "models/\(Self.model)",
                    generationConfig: .init(responseModalities: ["TEXT"]),
                    inputAudioTranscription: .init(languageCodes: [], mode: "SMART"),
                    sessionResumption: .init(handle: handle)
                )
            )))
        } catch {
            await nextSocket.cancel()
            socket = nil
            throw GeminiLiveTranscriptionError.connectionLost
        }
        scheduleTimeout(connectionTimeout, error: .connectionTimedOut)
    }

    private func receiveLoop() async {
        while !Task.isCancelled, token != nil {
            guard let socket else { return }
            let receivingGeneration = generation
            do {
                let message = try await socket.receive()
                guard receivingGeneration == generation else { continue }
                try await handle(message)
            } catch is CancellationError {
                return
            } catch {
                guard receivingGeneration == generation else { continue }
                guard await reconnectIfPossible() else {
                    await finish(error: GeminiLiveTranscriptionError.connectionLost)
                    return
                }
            }
        }
    }

    private func handle(_ message: GeminiLiveWebSocketMessage) async throws {
        let data: Data
        switch message {
        case .data(let value):
            data = value
        case .string(let value):
            data = Data(value.utf8)
        }
        let response: ServerMessage
        do {
            response = try JSONDecoder().decode(ServerMessage.self, from: data)
        } catch {
            throw GeminiLiveTranscriptionError.invalidResponse
        }

        if let handle = response.sessionResumptionUpdate?.newHandle, !handle.isEmpty {
            resumptionHandle = handle
        }
        if response.setupComplete != nil {
            timeoutTask?.cancel()
            timeoutTask = nil
            isReady = true
            let reconnected = isReconnecting
            isReconnecting = false
            reconnectAttempts = 0
            continuation?.yield(.ready)
            if reconnected, let socket {
                let pending = bufferedAudio
                bufferedAudio.removeAll(keepingCapacity: true)
                for data in pending {
                    try await sendAudio(data, over: socket)
                }
                if isFinishing {
                    try await sendAudioStreamEnd(over: socket)
                }
            }
        }
        if response.goAway != nil {
            guard await reconnectIfPossible() else {
                throw GeminiLiveTranscriptionError.connectionLost
            }
            return
        }
        if let text = response.serverContent?.interimInputTranscription?.text, !text.isEmpty {
            continuation?.yield(.interim(text))
        }
        if let text = response.serverContent?.inputTranscription?.text, !text.isEmpty {
            continuation?.yield(.final(text))
        }
        if response.serverContent?.turnComplete == true
            || response.serverContent?.generationComplete == true {
            continuation?.yield(.completed)
            await finish(error: nil)
        }
    }

    private func reconnectIfPossible() async -> Bool {
        guard !isFinishing,
              reconnectAttempts < 1,
              let handle = resumptionHandle,
              !handle.isEmpty else {
            return false
        }
        reconnectAttempts += 1
        isReconnecting = true
        isReady = false
        continuation?.yield(.reconnecting)
        await socket?.cancel()
        do {
            try await openSocket(resumingWith: handle)
            return true
        } catch {
            return false
        }
    }

    private func sendAudio(_ data: Data, over socket: any GeminiLiveWebSocket) async throws {
        try await socket.send(try Self.encoded(RealtimeInputEnvelope(
            realtimeInput: .init(
                audio: .init(data: data.base64EncodedString(), mimeType: Self.audioMIMEType),
                audioStreamEnd: nil
            )
        )))
    }

    private func sendAudioStreamEnd(over socket: any GeminiLiveWebSocket) async throws {
        try await socket.send(try Self.encoded(RealtimeInputEnvelope(
            realtimeInput: .init(audio: nil, audioStreamEnd: true)
        )))
        scheduleTimeout(completionTimeout, error: .responseTimedOut)
    }

    private func scheduleTimeout(_ duration: Duration, error: GeminiLiveTranscriptionError) {
        timeoutTask?.cancel()
        let timeoutGeneration = generation
        timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: duration)
            } catch {
                return
            }
            await self?.failIfCurrent(generation: timeoutGeneration, error: error)
        }
    }

    private func failIfCurrent(generation: Int, error: GeminiLiveTranscriptionError) async {
        guard generation == self.generation, token != nil else { return }
        await finish(error: error)
    }

    private func finish(error: GeminiLiveTranscriptionError?) async {
        timeoutTask?.cancel()
        timeoutTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        await socket?.cancel()
        socket = nil
        token = nil
        resumptionHandle = nil
        generation &+= 1
        reconnectAttempts = 0
        isReady = false
        isReconnecting = false
        isFinishing = false
        bufferedAudio.removeAll(keepingCapacity: false)
        if let error {
            continuation?.finish(throwing: error)
        } else {
            continuation?.finish()
        }
        continuation = nil
    }

    private static func encoded<T: Encodable>(_ value: T) throws -> Data {
        try JSONEncoder().encode(value)
    }
}

private struct SetupEnvelope: Encodable {
    let setup: Setup

    struct Setup: Encodable {
        let model: String
        let generationConfig: GenerationConfig
        let inputAudioTranscription: AudioTranscription
        let sessionResumption: SessionResumption
    }

    struct GenerationConfig: Encodable {
        let responseModalities: [String]
    }

    struct AudioTranscription: Encodable {
        let languageCodes: [String]
        let mode: String
    }

    struct SessionResumption: Encodable {
        let handle: String?
    }
}

private struct RealtimeInputEnvelope: Encodable {
    let realtimeInput: RealtimeInput

    struct RealtimeInput: Encodable {
        let audio: Audio?
        let audioStreamEnd: Bool?
    }

    struct Audio: Encodable {
        let data: String
        let mimeType: String
    }
}

private struct ServerMessage: Decodable {
    let setupComplete: EmptyObject?
    let serverContent: ServerContent?
    let sessionResumptionUpdate: SessionResumptionUpdate?
    let goAway: GoAway?

    struct EmptyObject: Decodable {}

    struct ServerContent: Decodable {
        let interimInputTranscription: Transcription?
        let inputTranscription: Transcription?
        let turnComplete: Bool?
        let generationComplete: Bool?
    }

    struct Transcription: Decodable {
        let text: String
    }

    struct SessionResumptionUpdate: Decodable {
        let newHandle: String?
    }

    struct GoAway: Decodable {
        let timeLeft: String?
    }
}
