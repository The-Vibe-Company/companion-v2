#if DEBUG
import CompanionKit
import Foundation
import SwiftUI

struct CompanionTranscriptWindowDemoView: View {
    var body: some View {
        NavigationStack {
            ChatView(
                companion: CompanionTranscriptWindowDemoFixtures.companion,
                onResources: {},
                onPlugins: {},
                services: CompanionTranscriptWindowDemoFixtures.services,
                onSettings: {}
            )
        }
    }
}

@MainActor
private enum CompanionTranscriptWindowDemoFixtures {
    static let companionID = "c96ab360-00f3-4497-a51a-51442db8add1"

    static let companion: CompanionSummary = decode(#"""
    {
      "id":"c96ab360-00f3-4497-a51a-51442db8add1",
      "name":"Luna",
      "persona":"Keep long conversations legible",
      "model_id":"claude-sonnet",
      "selected_skill_ids":[],
      "icon":{"shape":1,"mouth":1,"accessory":6,"color":7},
      "access":"owner",
      "hidden":false,
      "unread":false,
      "last_message":{"preview":"Long-thread message 120","role":"assistant","created_at":"2026-08-26T12:00:00.000Z"},
      "runtime":{"state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}
    }
    """#)

    static let thread: CompanionThread = {
        let entries: [[String: Any]] = (1...120).map { index in
            [
                "event_id": "long-\(index)",
                "ordinal": index,
                "role": "assistant",
                "content": "Long-thread message \(index)",
                "author_id": NSNull(),
                "author_name": NSNull(),
                "decision": NSNull(),
                "tool": NSNull(),
                "queued": false,
                "attachments": [Any](),
                "created_at": String(format: "2026-08-26T%02d:%02d:00.000Z", index / 60, index % 60),
            ]
        }
        let payload: [String: Any] = [
            "companion_id": companionID,
            "viewer_id": "owner-1",
            "read_only": false,
            "can_send": true,
            "entries": entries,
            "queued_count": 0,
            "interrupted_turn": NSNull(),
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(CompanionThread.self, from: data)
    }()

    static let services = ChatServices(
        thread: { _ in thread },
        listCompanions: { [companion] },
        decide: { _, _, _ in thread },
        retryTurn: { _, _, _ in throw CompanionTranscriptWindowDemoError.unavailable },
        cancelTurn: { _, _ in thread },
        listSkills: { [] },
        listPlugins: { [] },
        listProviders: { throw CompanionTranscriptWindowDemoError.unavailable }
    )

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}

private enum CompanionTranscriptWindowDemoError: Error {
    case unavailable
}
#endif
