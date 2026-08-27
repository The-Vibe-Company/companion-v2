import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import CompanionKit

private final class TranscriptionURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (response, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try #require(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
        if count == 0 { break }
        body.append(buffer, count: count)
    }
    return body
}

@Test
func uploadsOneCompressedRecordingAndDecodesOnlyTheTranscript() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [TranscriptionURLProtocol.self]
    let apiURL = try #require(URL(string: "https://api.example.test"))
    let audio = Data([0, 0, 0, 20, 102, 116, 121, 112, 77, 52, 65, 32])
    TranscriptionURLProtocol.handler = { request in
        #expect(request.url?.path == "/v1/companions/companion one/transcriptions")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "session=secret")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-one")
        let contentType = try #require(request.value(forHTTPHeaderField: "Content-Type"))
        #expect(contentType.hasPrefix("multipart/form-data; boundary="))
        let body = try requestBody(request)
        let bodyText = String(decoding: body, as: UTF8.self)
        #expect(bodyText.contains("name=\"audio\"; filename=\"recording.m4a\""))
        #expect(bodyText.contains("Content-Type: audio/mp4"))
        #expect(body.range(of: audio) != nil)
        let response = try #require(HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ))
        return (response, Data(#"{"transcript":"Envoie le devis à Camille."}"#.utf8))
    }
    defer { TranscriptionURLProtocol.handler = nil }

    let client = APIClient(baseURL: apiURL, session: URLSession(configuration: configuration))
    await client.setAuthority(Session(
        cookie: "session=secret",
        orgID: "org-one",
        needsOnboarding: false,
        user: .init(id: "user-one", email: "owner@example.test", name: "Owner")
    ))
    let result = try await client.transcribeCompanionAudio(
        companionID: "companion one",
        audio: audio
    )
    #expect(result == CompanionTranscription(transcript: "Envoie le devis à Camille."))
}

@Test
func rejectsEmptyAndOversizedRecordingsBeforeTheNetwork() async {
    let client = APIClient(baseURL: URL(string: "https://api.example.test")!)
    await #expect(throws: CompanionTranscriptionError.emptyAudio) {
        _ = try await client.transcribeCompanionAudio(companionID: "companion", audio: Data())
    }
    await #expect(throws: CompanionTranscriptionError.audioTooLarge) {
        _ = try await client.transcribeCompanionAudio(
            companionID: "companion",
            audio: Data(count: companionTranscriptionAudioMaximumBytes + 1)
        )
    }
}
