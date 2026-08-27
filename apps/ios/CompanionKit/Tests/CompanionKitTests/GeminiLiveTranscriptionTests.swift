import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import CompanionKit

private actor MockGeminiLiveWebSocket: GeminiLiveWebSocket {
    private var incoming: [Result<GeminiLiveWebSocketMessage, Error>] = []
    private var waiter: CheckedContinuation<GeminiLiveWebSocketMessage, Error>?
    private var sent: [Data] = []
    private var resumed = false

    func resume() {
        resumed = true
    }

    func send(_ data: Data) {
        sent.append(data)
    }

    func receive() async throws -> GeminiLiveWebSocketMessage {
        if !incoming.isEmpty {
            return try incoming.removeFirst().get()
        }
        return try await withCheckedThrowingContinuation { continuation in
            waiter = continuation
        }
    }

    func cancel() {
        waiter?.resume(throwing: CancellationError())
        waiter = nil
    }

    func enqueue(_ message: GeminiLiveWebSocketMessage) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: message)
        } else {
            incoming.append(.success(message))
        }
    }

    func fail() {
        if let waiter {
            self.waiter = nil
            waiter.resume(throwing: URLError(.networkConnectionLost))
        } else {
            incoming.append(.failure(URLError(.networkConnectionLost)))
        }
    }

    func snapshot() -> (resumed: Bool, sent: [Data]) {
        (resumed, sent)
    }
}

private final class MockGeminiSocketFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var sockets: [MockGeminiLiveWebSocket]
    private var requestedURLs: [URL] = []

    init(_ sockets: [MockGeminiLiveWebSocket]) {
        self.sockets = sockets
    }

    func make(url: URL) -> any GeminiLiveWebSocket {
        lock.lock()
        defer { lock.unlock() }
        requestedURLs.append(url)
        return sockets.removeFirst()
    }

    func urls() -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        return requestedURLs
    }
}

private final class TranscriptionSessionURLProtocol: URLProtocol, @unchecked Sendable {
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

@Test
func connectsStreamsPCMAndPublishesTranscriptDeltas() async throws {
    let socket = MockGeminiLiveWebSocket()
    let socketFactory = MockGeminiSocketFactory([socket])
    let client = GeminiLiveTranscriptionClient(factory: .init(makeSocket: socketFactory.make))
    let stream = try await client.connect(token: "short-lived-token")
    var iterator = stream.makeAsyncIterator()

    await socket.enqueue(.string(#"{"setupComplete":{}}"#))
    #expect(try await iterator.next() == .ready)

    let audio = Data([0x01, 0x00, 0x02, 0x00])
    try await client.sendPCM16(audio)
    await socket.enqueue(.string(#"{"serverContent":{"interimInputTranscription":{"text":"Ship the"}}}"#))
    await socket.enqueue(.string(#"{"serverContent":{"inputTranscription":{"text":"Ship the release."}}}"#))
    #expect(try await iterator.next() == .interim("Ship the"))
    #expect(try await iterator.next() == .final("Ship the release."))

    try await client.finishAudio()
    await socket.enqueue(.string(#"{"serverContent":{"turnComplete":true}}"#))
    #expect(try await iterator.next() == .completed)

    let snapshot = await socket.snapshot()
    #expect(snapshot.resumed)
    #expect(snapshot.sent.count == 3)

    let setup = try #require(try JSONSerialization.jsonObject(with: snapshot.sent[0]) as? [String: Any])
    let setupBody = try #require(setup["setup"] as? [String: Any])
    #expect(setupBody["model"] as? String == "models/gemini-3.5-transcribe-live")
    let generation = try #require(setupBody["generationConfig"] as? [String: Any])
    #expect(generation["responseModalities"] as? [String] == ["TEXT"])
    let transcription = try #require(setupBody["inputAudioTranscription"] as? [String: Any])
    #expect(transcription["languageCodes"] as? [String] == [])
    #expect(transcription["mode"] as? String == "SMART")

    let frame = try #require(try JSONSerialization.jsonObject(with: snapshot.sent[1]) as? [String: Any])
    let realtimeInput = try #require(frame["realtimeInput"] as? [String: Any])
    let encodedAudio = try #require(realtimeInput["audio"] as? [String: Any])
    #expect(encodedAudio["data"] as? String == audio.base64EncodedString())
    #expect(encodedAudio["mimeType"] as? String == "audio/pcm;rate=16000")

    let url = try #require(socketFactory.urls().first)
    #expect(url.host == "generativelanguage.googleapis.com")
    #expect(url.path.hasSuffix("BidiGenerateContentConstrained"))
    #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == [
        URLQueryItem(name: "access_token", value: "short-lived-token"),
    ])
}

@Test
func resumesOnceAndFlushesBoundedAudioAfterGoAway() async throws {
    let firstSocket = MockGeminiLiveWebSocket()
    let secondSocket = MockGeminiLiveWebSocket()
    let socketFactory = MockGeminiSocketFactory([firstSocket, secondSocket])
    let client = GeminiLiveTranscriptionClient(factory: .init(makeSocket: socketFactory.make))
    let stream = try await client.connect(token: "short-lived-token")
    var iterator = stream.makeAsyncIterator()

    await firstSocket.enqueue(.string(
        #"{"setupComplete":{},"sessionResumptionUpdate":{"newHandle":"resume-handle"}}"#
    ))
    #expect(try await iterator.next() == .ready)
    await firstSocket.enqueue(.string(#"{"goAway":{"timeLeft":"1s"}}"#))
    #expect(try await iterator.next() == .reconnecting)

    let audio = Data([0x01, 0x00])
    try await client.sendPCM16(audio)
    await secondSocket.enqueue(.string(#"{"setupComplete":{}}"#))
    #expect(try await iterator.next() == .ready)

    let secondSnapshot = await secondSocket.snapshot()
    #expect(secondSnapshot.sent.count == 2)
    let setup = try #require(try JSONSerialization.jsonObject(with: secondSnapshot.sent[0]) as? [String: Any])
    let setupBody = try #require(setup["setup"] as? [String: Any])
    let resumption = try #require(setupBody["sessionResumption"] as? [String: Any])
    #expect(resumption["handle"] as? String == "resume-handle")

    await client.close()
}

@Test
func resumesWhileFinishingAndResendsAudioStreamEnd() async throws {
    let firstSocket = MockGeminiLiveWebSocket()
    let secondSocket = MockGeminiLiveWebSocket()
    let socketFactory = MockGeminiSocketFactory([firstSocket, secondSocket])
    let client = GeminiLiveTranscriptionClient(factory: .init(makeSocket: socketFactory.make))
    let stream = try await client.connect(token: "short-lived-token")
    var iterator = stream.makeAsyncIterator()

    await firstSocket.enqueue(.string(
        #"{"setupComplete":{},"sessionResumptionUpdate":{"newHandle":"finish-handle"}}"#
    ))
    #expect(try await iterator.next() == .ready)
    try await client.finishAudio()
    await firstSocket.fail()
    #expect(try await iterator.next() == .reconnecting)

    await secondSocket.enqueue(.string(#"{"setupComplete":{}}"#))
    #expect(try await iterator.next() == .ready)
    let snapshot = await secondSocket.snapshot()
    #expect(snapshot.sent.count == 2)
    let end = try #require(try JSONSerialization.jsonObject(with: snapshot.sent[1]) as? [String: Any])
    let realtimeInput = try #require(end["realtimeInput"] as? [String: Any])
    #expect(realtimeInput["audioStreamEnd"] as? Bool == true)

    await secondSocket.enqueue(.string(#"{"serverContent":{"turnComplete":true}}"#))
    #expect(try await iterator.next() == .completed)
}

@Test
func boundsConnectionAndCompletionWaits() async throws {
    let connectionSocket = MockGeminiLiveWebSocket()
    let connectionClient = GeminiLiveTranscriptionClient(
        factory: .init(makeSocket: { _ in connectionSocket }),
        connectionTimeout: .milliseconds(20)
    )
    let connectionStream = try await connectionClient.connect(token: "short-lived-token")
    var connectionIterator = connectionStream.makeAsyncIterator()
    await #expect(throws: GeminiLiveTranscriptionError.connectionTimedOut) {
        _ = try await connectionIterator.next()
    }

    let completionSocket = MockGeminiLiveWebSocket()
    let completionClient = GeminiLiveTranscriptionClient(
        factory: .init(makeSocket: { _ in completionSocket }),
        completionTimeout: .milliseconds(20)
    )
    let completionStream = try await completionClient.connect(token: "short-lived-token")
    var completionIterator = completionStream.makeAsyncIterator()
    await completionSocket.enqueue(.string(#"{"setupComplete":{}}"#))
    #expect(try await completionIterator.next() == .ready)
    try await completionClient.finishAudio()
    await #expect(throws: GeminiLiveTranscriptionError.responseTimedOut) {
        _ = try await completionIterator.next()
    }
}

@Test
func requestsAnEphemeralSessionThroughTheSharedCompanionEndpoint() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [TranscriptionSessionURLProtocol.self]
    let urlSession = URLSession(configuration: configuration)
    let apiURL = try #require(URL(string: "https://api.example.test"))
    TranscriptionSessionURLProtocol.handler = { request in
        #expect(request.url?.path == "/v1/companions/companion one/transcription-sessions")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "session=secret")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-one")
        let response = try #require(HTTPURLResponse(
            url: request.url!,
            statusCode: 201,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ))
        return (response, Data(#"{"token":"ephemeral","expires_at":"2026-08-27T11:00:00.000Z","model":"gemini-3.5-transcribe-live"}"#.utf8))
    }
    defer { TranscriptionSessionURLProtocol.handler = nil }

    let client = APIClient(baseURL: apiURL, session: urlSession)
    await client.setAuthority(Session(
        cookie: "session=secret",
        orgID: "org-one",
        needsOnboarding: false,
        user: .init(id: "user-one", email: "owner@example.test", name: "Owner")
    ))
    let session = try await client.createCompanionTranscriptionSession(companionID: "companion one")
    #expect(session == CompanionTranscriptionSession(
        token: "ephemeral",
        expiresAt: "2026-08-27T11:00:00.000Z",
        model: "gemini-3.5-transcribe-live"
    ))
}
