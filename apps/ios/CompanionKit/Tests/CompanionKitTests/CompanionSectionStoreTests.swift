import Foundation
import Testing
@testable import CompanionKit

@Test
func sectionStoreOrdersGroupsAndKeepsUnassignedLast() throws {
    let sections = try decodeSections()
    var store = CompanionSectionStore()
    store.reconcile(with: Array(sections.reversed()))
    let companions = try decodeCompanions()
    let groups = store.groups(companions: companions)

    #expect(groups.map(\.name) == ["Work", "Personal", "Unassigned"])
    #expect(groups[0].usesPinnedGrid)
    #expect(groups[2].companions.map(\.name) == ["Orbit"])
}

@Test
func deletingASectionProjectsItsCompanionsAsUnassigned() throws {
    let sections = try decodeSections()
    var store = CompanionSectionStore(sections: sections)
    store.remove(sectionID: sections[0].id)
    let groups = store.groups(companions: try decodeCompanions())

    #expect(groups.last?.name == "Unassigned")
    #expect(groups.last?.companions.contains(where: { $0.name == "Luna" }) == true)
}

@Test
func collapsedStateIsStableAndPrunedDuringReconcile() throws {
    let sections = try decodeSections()
    var store = CompanionSectionStore(sections: sections)
    store.toggleCollapsed(sectionID: sections[0].id)
    #expect(store.groups(companions: try decodeCompanions())[0].isCollapsed)
    store.reconcile(with: [sections[1]])
    #expect(store.collapsedSectionIDs.isEmpty)
}

@Test
func unassignedCanStayCollapsedAcrossReconciliation() throws {
    var store = CompanionSectionStore(sections: try decodeSections())
    store.toggleCollapsed(sectionID: "unassigned")
    store.reconcile(with: try decodeSections())
    #expect(store.groups(companions: try decodeCompanions()).last?.isCollapsed == true)
}

private func decodeSections() throws -> [CompanionSection] {
    let data = Data(#"""
    [
      {"id":"11111111-1111-4111-8111-111111111111","org_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","owner_id":"user-1","name":"Work","position":0,"created_at":"2026-08-27T00:00:00Z","updated_at":"2026-08-27T00:00:00Z"},
      {"id":"22222222-2222-4222-8222-222222222222","org_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","owner_id":"user-1","name":"Personal","position":1,"created_at":"2026-08-27T00:00:00Z","updated_at":"2026-08-27T00:00:00Z"}
    ]
    """#.utf8)
    return try JSONDecoder().decode([CompanionSection].self, from: data)
}

private func decodeCompanions() throws -> [CompanionSummary] {
    let data = Data(#"""
    [
      {"id":"33333333-3333-4333-8333-333333333333","name":"Luna","section_id":"11111111-1111-4111-8111-111111111111","access":"owner","pinned":false,"hidden":false,"unread":false,"runtime":{"state":"stopped","daemon_state":"stopped","replying":false,"provider_ids":[]}},
      {"id":"44444444-4444-4444-8444-444444444444","name":"Nova","section_id":"22222222-2222-4222-8222-222222222222","access":"owner","pinned":false,"hidden":false,"unread":false,"runtime":{"state":"stopped","daemon_state":"stopped","replying":false,"provider_ids":[]}},
      {"id":"55555555-5555-4555-8555-555555555555","name":"Orbit","access":"owner","pinned":false,"hidden":false,"unread":false,"runtime":{"state":"stopped","daemon_state":"stopped","replying":false,"provider_ids":[]}}
    ]
    """#.utf8)
    return try JSONDecoder().decode([CompanionSummary].self, from: data)
}
