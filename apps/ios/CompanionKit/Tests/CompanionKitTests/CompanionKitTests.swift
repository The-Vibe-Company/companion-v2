import Testing
@testable import CompanionKit

@Test
func usesTheSharedAPIContract() {
    #expect(CompanionKit.apiRootPath == "/v1")
}
