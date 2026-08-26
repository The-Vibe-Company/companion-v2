#if DEBUG
import CompanionKit
import SwiftUI

struct CompanionQueuedMessagesDemoView: View {
    private let canManage: Bool
    private let failRemovalOnce: Bool
    @State private var entries = CompanionQueuedMessagesDemoFixtures.entries
    @State private var draft = ""
    @State private var removalAttempts = 0

    init() {
        canManage = ProcessInfo.processInfo.environment["COMPANION_QUEUED_DEMO_ACCESS"] != "viewer"
        failRemovalOnce = ProcessInfo.processInfo.environment["COMPANION_QUEUED_DEMO_FAIL_ONCE"] == "1"
    }

    var body: some View {
        NavigationStack {
            CompanionBackdrop(style: .companion(.blue)) {
                ScrollView {
                    LazyVStack(spacing: 16) {
                        ChatMessageBubble(
                            content: "I’m preparing the release notes now.",
                            kind: .assistant,
                            timestamp: "11:02 AM",
                            companionName: "Luna"
                        )
                        ChatMessageBubble(
                            content: "Add the screenshots when this is ready.",
                            kind: .mine,
                            timestamp: "11:03 AM",
                            accent: .blue
                        )
                    }
                    .padding(16)
                }
                .safeAreaInset(edge: .bottom) {
                    VStack(spacing: 8) {
                        if !entries.isEmpty {
                            CompanionQueuedMessagesView(
                                entries: entries,
                                canManage: canManage,
                                accent: .blue,
                                onRemove: remove
                            )
                            .padding(.horizontal, 12)
                        }

                        HStack(spacing: 10) {
                            TextField("Message Luna", text: $draft)
                                .padding(.horizontal, 16)
                                .frame(minHeight: 46)
                                .companionGlass(radius: 23, interactive: true)
                                .accessibilityIdentifier("queue.demo.composer")

                            Button { } label: {
                                Image(systemName: "arrow.up")
                                    .frame(width: 46, height: 46)
                            }
                            .buttonStyle(.glassProminent)
                            .buttonBorderShape(.circle)
                            .tint(.blue)
                            .disabled(true)
                            .accessibilityLabel("Send message")
                        }
                        .padding(.horizontal, 12)
                        .padding(.bottom, 6)
                    }
                }
            }
            .navigationTitle("Queued messages")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func remove(_ turnID: String) async throws {
        try await Task.sleep(for: .milliseconds(120))
        removalAttempts += 1
        if failRemovalOnce && removalAttempts == 1 {
            throw CompanionQueuedMessagesDemoError.simulatedFailure
        }
        entries.removeAll { $0.turnID == turnID }
    }
}

private enum CompanionQueuedMessagesDemoError: Error {
    case simulatedFailure
}

private enum CompanionQueuedMessagesDemoFixtures {
    static let entries: [TranscriptEntry] = decode(#"""
    [
      {
        "event_id":"msg:11111111-1111-4111-8111-111111111111",
        "ordinal":11,
        "role":"user",
        "content":"Compare these screenshots and call out the visual regressions.",
        "author_id":"owner-1",
        "author_name":"Stan",
        "turn_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "queued":true,
        "attachments":[
          {"id":"image-1","kind":"user_upload","content_type":"image/png","byte_size":2048,"filename":"before.png","position":0},
          {"id":"image-2","kind":"user_upload","content_type":"image/jpeg","byte_size":3072,"filename":"after.jpg","position":1},
          {"id":"notes-1","kind":"user_upload","content_type":"text/plain","byte_size":512,"filename":"notes.txt","position":2}
        ],
        "created_at":"2026-08-26T11:04:00.000Z"
      },
      {
        "event_id":"msg:22222222-2222-4222-8222-222222222222",
        "ordinal":12,
        "role":"user",
        "content":"Then tighten the empty-state copy.",
        "author_id":"owner-1",
        "author_name":"Stan",
        "turn_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "queued":true,
        "attachments":[],
        "created_at":"2026-08-26T11:05:00.000Z"
      },
      {
        "event_id":"msg:33333333-3333-4333-8333-333333333333",
        "ordinal":13,
        "role":"user",
        "content":"Finish with an accessibility pass.",
        "author_id":"owner-1",
        "author_name":"Stan",
        "turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "queued":true,
        "attachments":[
          {"id":"checklist-1","kind":"user_upload","content_type":"application/pdf","byte_size":4096,"filename":"checklist.pdf","position":0}
        ],
        "created_at":"2026-08-26T11:06:00.000Z"
      }
    ]
    """#)

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        guard let data = json.data(using: .utf8),
              let value = try? JSONDecoder().decode(Value.self, from: data) else {
            preconditionFailure("Invalid queued-message demo fixture")
        }
        return value
    }
}
#endif
