import Foundation
import Testing
@testable import CompanionKit

private final class CompanionDesktopMockURLProtocol: URLProtocol, @unchecked Sendable {
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
func decodesTheSharedDesktopHandoffContract() throws {
    let desktop = try JSONDecoder().decode(CompanionDesktop.self, from: Data(#"""
    {
      "desktop_url":"https://desktop.example.test/vnc?token=secret",
      "provisioning":false,
      "automation":"lux",
      "transport":"vnc"
    }
    """#.utf8))

    #expect(desktop.desktopURL?.host == "desktop.example.test")
    #expect(desktop.provisioning == false)
    #expect(desktop.automation == "lux")
    #expect(desktop.transport == .vnc)
}

@Test
func desktopHandoffMayBeProvisioningWithoutAURL() throws {
    let desktop = try JSONDecoder().decode(CompanionDesktop.self, from: Data(#"""
    {
      "desktop_url":null,
      "provisioning":true,
      "automation":"lux",
      "transport":null
    }
    """#.utf8))

    #expect(desktop.desktopURL == nil)
    #expect(desktop.provisioning)
    #expect(desktop.transport == nil)
}

@Test
func requestsAFreshDesktopURLThroughTheSharedRoute() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CompanionDesktopMockURLProtocol.self]
    CompanionDesktopMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        #expect(requestURL.path == "/v1/companions/companion-1/runtime/desktop")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-1")
        let response = try #require(HTTPURLResponse(
            url: requestURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Cache-Control": "private, no-store"]
        ))
        return (response, Data(#"""
        {"desktop_url":"https://desktop.example.test/vnc?token=secret","provisioning":false,"automation":"lux","transport":"vnc"}
        """#.utf8))
    }
    defer { CompanionDesktopMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "member@example.com", name: "Member")
    ))

    let desktop = try await client.openCompanionDesktop(companionID: "companion-1")
    #expect(desktop.desktopURL?.host == "desktop.example.test")
}
