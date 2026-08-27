import Foundation
import CompanionKit
import XCTest
@testable import CompanionMac

final class MacProjectionTests: XCTestCase {
    func testRosterProjectionPreservesServerOrderAndSeparatesHiddenRows() throws {
        let companions = try makeCompanions()
        let projection = CompanionMacRosterProjection(
            companions: companions,
            query: "",
            hiddenExpanded: false
        )

        XCTAssertEqual(projection.sections.pinned.map(\.name), ["Pinned"])
        XCTAssertEqual(projection.sections.unpinned.map(\.name), ["Visible"])
        XCTAssertEqual(projection.sections.hidden.map(\.name), ["Hidden"])
        XCTAssertEqual(projection.visibleCompanions.map(\.name), ["Pinned", "Visible"])
        XCTAssertEqual(projection.totalMatchCount, 3)
    }

    func testRosterProjectionSearchesNamePersonaAndLastMessageAndExpandsHidden() throws {
        let companions = try makeCompanions()

        let personaMatch = CompanionMacRosterProjection(companions: companions, query: "review")
        XCTAssertEqual(personaMatch.visibleCompanions.map(\.name), ["Visible"])

        let messageMatch = CompanionMacRosterProjection(companions: companions, query: "deploy")
        XCTAssertEqual(messageMatch.visibleCompanions.map(\.name), ["Hidden"])

        let expanded = CompanionMacRosterProjection(companions: companions, hiddenExpanded: true)
        XCTAssertEqual(expanded.visibleCompanions.map(\.name), ["Pinned", "Visible", "Hidden"])
    }

    func testDesktopEligibilityRequiresOwnerOrEditorAndRunningBox() {
        XCTAssertEqual(
            CompanionMacDesktopEligibility.evaluate(access: .owner, runtimeState: .running),
            .allowed
        )
        XCTAssertEqual(
            CompanionMacDesktopEligibility.evaluate(access: .editor, runtimeState: .running),
            .allowed
        )
        XCTAssertEqual(
            CompanionMacDesktopEligibility.evaluate(access: .viewer, runtimeState: .running),
            .viewerReadOnly
        )
        XCTAssertEqual(
            CompanionMacDesktopEligibility.evaluate(access: .owner, runtimeState: .stopped),
            .boxNotRunning
        )
    }

    private func makeCompanions() throws -> [CompanionSummary] {
        let payload = #"[
          {"id":"pinned","name":"Pinned","persona":"Operations","model_id":"model","selected_skill_ids":[],"selected_mcp_account_ids":[],"icon":{"shape":1,"mouth":1,"accessory":1,"color":2},"access":"owner","pinned":true,"hidden":false,"unread":false,"last_message":{"preview":"Ready","role":"assistant","created_at":"2026-08-26T12:00:00Z"},"runtime":{"state":"running","daemon_state":"running","replying":false,"provider_ids":["provider"]}},
          {"id":"visible","name":"Visible","persona":"Review queue","model_id":"model","selected_skill_ids":[],"selected_mcp_account_ids":[],"icon":{"shape":1,"mouth":1,"accessory":1,"color":2},"access":"editor","pinned":false,"hidden":false,"unread":true,"last_message":{"preview":"No new messages","role":"user","created_at":"2026-08-26T12:00:00Z"},"runtime":{"state":"stopped","daemon_state":"stopped","replying":false,"provider_ids":["provider"]}},
          {"id":"hidden","name":"Hidden","persona":"Maintenance","model_id":"model","selected_skill_ids":[],"selected_mcp_account_ids":[],"icon":{"shape":1,"mouth":1,"accessory":1,"color":2},"access":"owner","pinned":false,"hidden":true,"unread":false,"last_message":{"preview":"Deploy complete","role":"assistant","created_at":"2026-08-26T12:00:00Z"},"runtime":{"state":"running","daemon_state":"running","replying":false,"provider_ids":["provider"]}}
        ]"#
        return try JSONDecoder().decode([CompanionSummary].self, from: Data(payload.utf8))
    }
}
