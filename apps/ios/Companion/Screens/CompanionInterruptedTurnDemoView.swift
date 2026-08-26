#if DEBUG
import CompanionKit
import SwiftUI

struct CompanionInterruptedTurnDemoView: View {
    private let canAct: Bool
    private let failRetryOnce: Bool
    private let supersedeRetry: Bool
    @State private var released = false
    @State private var retryAttempts = 0
    @State private var firstRetryID: UUID?
    @State private var latestOperation: CompanionOperationSummary?

    init() {
        let access = ProcessInfo.processInfo.environment["COMPANION_INTERRUPTION_DEMO_ACCESS"] ?? "owner"
        canAct = access == "owner" || access == "editor"
        failRetryOnce = ProcessInfo.processInfo.environment["COMPANION_INTERRUPTION_DEMO_FAIL_RETRY_ONCE"] == "1"
        supersedeRetry = ProcessInfo.processInfo.environment["COMPANION_INTERRUPTION_DEMO_SUPERSEDE_RETRY"] == "1"
    }

    var body: some View {
        NavigationStack {
            CompanionBackdrop(style: .neutral) {
                ScrollView {
                    if released {
                        ContentUnavailableView(
                            "Queue released",
                            systemImage: "checkmark.circle",
                            description: Text("The two waiting messages can continue in order.")
                        )
                        .accessibilityIdentifier("interruption.demo.released")
                        .padding(.top, 80)
                    } else {
                        CompanionInterruptedTurnNotice(
                            turn: CompanionInterruptedTurnDemoFixtures.turn,
                            queuedCount: 2,
                            canAct: canAct,
                            latestOperation: latestOperation,
                            accent: .companionAccent,
                            accentForeground: .white,
                            onRetry: { _, retryID in
                                try await Task.sleep(for: .milliseconds(120))
                                if let firstRetryID, firstRetryID != retryID {
                                    throw CompanionInterruptedTurnDemoError.retryIDChanged
                                }
                                if firstRetryID == nil { firstRetryID = retryID }
                                retryAttempts += 1
                                if failRetryOnce && retryAttempts == 1 {
                                    throw CompanionInterruptedTurnDemoError.simulatedFailure
                                }
                                if supersedeRetry {
                                    Task { @MainActor in
                                        try await Task.sleep(for: .milliseconds(250))
                                        latestOperation = CompanionInterruptedTurnDemoFixtures.newerFailedRetry
                                    }
                                }
                                return CompanionInterruptedTurnDemoFixtures.retryOperation
                            },
                            onCancel: { _ in
                                try await Task.sleep(for: .milliseconds(120))
                                released = true
                            }
                        )
                        .padding(16)
                    }
                }
            }
            .navigationTitle("Interrupted turn")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private enum CompanionInterruptedTurnDemoError: LocalizedError {
    case simulatedFailure
    case retryIDChanged

    var errorDescription: String? {
        switch self {
        case .simulatedFailure: "The retry request could not be confirmed. Try again."
        case .retryIDChanged: "The retry request did not preserve its idempotency key."
        }
    }
}

private enum CompanionInterruptedTurnDemoFixtures {
    static let turn: CompanionTurn = decode(#"""
    {
      "id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "client_message_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "status":"interrupted","queue_sequence":20,"latest_attempt":null,"replying":false,
      "error":{"code":"cold_start_deadline_exceeded","message":"The Companion did not start before its deadline.","action":"retry"},
      "state_changed_at":"2026-08-26T05:59:33.505Z","settled_at":"2026-08-26T05:59:33.505Z",
      "created_at":"2026-08-26T05:55:12.466Z","updated_at":"2026-08-26T05:59:33.505Z"
    }
    """#)

    static let retryOperation: CompanionOperationSummary = decode(#"""
    {
      "id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "source_turn_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "kind":"start","status":"pending","error":null
    }
    """#)

    static let newerFailedRetry: CompanionOperationSummary = decode(#"""
    {
      "id":"ffffffff-ffff-4fff-8fff-ffffffffffff",
      "source_turn_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "kind":"restart_pi","status":"failed",
      "error":{"code":"pi_crash_loop","message":"A newer retry could not stay running.","action":"restart_pi"}
    }
    """#)

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        guard let data = json.data(using: .utf8),
              let value = try? JSONDecoder().decode(Value.self, from: data) else {
            preconditionFailure("Invalid interrupted-turn demo fixture")
        }
        return value
    }
}
#endif
