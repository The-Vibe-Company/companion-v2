import Foundation
import Testing
@testable import CompanionKit

private final class AvatarMockURLProtocol: URLProtocol, @unchecked Sendable {
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
func avatarRequestsAuthenticateOnlyAgainstTheCompanionAPIOrigin() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AvatarMockURLProtocol.self]
    let client = APIClient(
        baseURL: try #require(URL(string: "https://api.example.test")),
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "session=secret",
        orgID: "11111111-1111-4111-8111-111111111111",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "member@example.test", name: "Member")
    ))

    AvatarMockURLProtocol.handler = { request in
        #expect(request.url?.host == "api.example.test")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "session=secret")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") != nil)
        let requestURL = try #require(request.url)
        return (try #require(HTTPURLResponse(
            url: requestURL, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "image/png"]
        )), Data([0x89, 0x50]))
    }
    _ = try await client.userAvatarData(at: "/v1/users/user-1/avatar")

    AvatarMockURLProtocol.handler = { request in
        #expect(request.url?.host == "secure.gravatar.com")
        #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == nil)
        let requestURL = try #require(request.url)
        return (try #require(HTTPURLResponse(
            url: requestURL, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "image/png"]
        )), Data([0x89, 0x50]))
    }
    _ = try await client.userAvatarData(at: "https://secure.gravatar.com/avatar/hash")
}
