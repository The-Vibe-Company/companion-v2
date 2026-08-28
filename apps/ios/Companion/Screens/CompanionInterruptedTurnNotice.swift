import CompanionKit
import SwiftUI

struct CompanionInterruptedTurnNotice: View {
    let turn: CompanionTurn
    let queuedCount: Int
    let canAct: Bool
    let latestOperation: CompanionOperationSummary?
    let accent: Color
    let accentForeground: Color
    let onRetry: (String, UUID) async throws -> CompanionOperationSummary
    let onCancel: (String) async throws -> Void

    @State private var action: Action?
    @State private var retryID: UUID?
    @State private var retryBaselineOperationID: String?
    @State private var acceptedRetry: CompanionOperationSummary?
    @State private var actionError: String?
    @AccessibilityFocusState private var errorFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title3)
                    .foregroundStyle(Color.companionDanger)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 5) {
                    Text("Turn interrupted")
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                    Text(turn.error?.message ?? "The runtime could not confirm how this turn ended.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionInk.opacity(0.82))
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Earlier external actions may already have succeeded.")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                }
            }

            if queuedCount > 0 {
                Text(queueMessage)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionMuted)
            }

            if !canAct {
                Text("An Owner or Editor must retry or cancel this turn before the conversation can continue.")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionMuted)
            } else {
                if retryPending {
                    Label(retryAcceptedMessage, systemImage: "clock")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.companionWarning)
                        .accessibilityIdentifier("chat.interrupted.retry-status")
                }

                if let retryFailure {
                    CompanionErrorNotice(message: retryFailure)
                }

                if let actionError {
                    Text(actionError)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.companionDanger)
                        .accessibilityFocused($errorFocused)
                        .accessibilityLabel("Action failed. \(actionError)")
                        .accessibilityIdentifier("chat.interrupted.error")
                }

                HStack(spacing: 10) {
                    if !retryPending {
                        Button(action: retry) {
                            actionLabel(
                                title: action == .retry ? "Requesting retry…" : "Retry turn",
                                loading: action == .retry
                            )
                        }
                        .buttonStyle(.glassProminent)
                        .tint(accent)
                        .foregroundStyle(accentForeground)
                        .disabled(action != nil)
                        .accessibilityIdentifier("chat.interrupted.retry")
                    }

                    Button(action: cancel) {
                        actionLabel(
                            title: action == .cancel ? "Cancelling…" : "Cancel turn",
                            loading: action == .cancel
                        )
                    }
                    .buttonStyle(.glass)
                    .disabled(action != nil)
                    .accessibilityIdentifier("chat.interrupted.cancel")
                }
                .controlSize(.regular)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .companionMaterial(radius: 12)
        .onChange(of: turn.id) { reset() }
        .onChange(of: latestOperation) { _, operation in
            guard let operation, operation.sourceTurnID == turn.id,
                  operation.kind == .start || operation.kind == .restartPi else { return }

            if let acceptedRetry,
               operation.id != acceptedRetry.id,
               operation.id != retryBaselineOperationID {
                self.acceptedRetry = nil
                retryID = nil
                retryBaselineOperationID = nil
            }

            guard operation.status == .failed || operation.status == .interrupted
                    || operation.status == .cancelled else { return }
            retryID = nil
            retryBaselineOperationID = nil
            if acceptedRetry?.id == operation.id { acceptedRetry = nil }
        }
        .onChange(of: actionError) { _, message in
            errorFocused = message != nil
        }
    }

    @ViewBuilder
    private func actionLabel(title: String, loading: Bool) -> some View {
        HStack(spacing: 7) {
            if loading { ProgressView().controlSize(.small) }
            Text(title)
        }
        .frame(minHeight: 32)
    }

    private var durableRetry: CompanionOperationSummary? {
        guard let latestOperation,
              latestOperation.sourceTurnID == turn.id,
              latestOperation.kind == .start || latestOperation.kind == .restartPi else { return nil }
        return latestOperation
    }

    private var retryOperation: CompanionOperationSummary? {
        if let acceptedRetry, let durableRetry, acceptedRetry.id != durableRetry.id {
            return durableRetry.id == retryBaselineOperationID ? acceptedRetry : durableRetry
        }
        return durableRetry ?? acceptedRetry
    }

    private var retryPending: Bool {
        retryOperation?.status == .pending || retryOperation?.status == .running
    }

    private var retryFailure: String? {
        guard let retryOperation,
              retryOperation.status == .failed || retryOperation.status == .interrupted else { return nil }
        return retryOperation.error?.message ?? (retryOperation.kind == .start
            ? "The Companion could not start. Retry or cancel this turn."
            : "Pi could not restart. Retry or cancel this turn.")
    }

    private var retryAcceptedMessage: String {
        retryOperation?.kind == .start
            ? "Retry accepted. The Companion will start before this turn runs again."
            : "Retry accepted. Pi will restart before this turn runs again."
    }

    private var queueMessage: String {
        let noun = queuedCount == 1 ? "message is" : "messages are"
        return "\(queuedCount) later \(noun) waiting behind this turn."
    }

    private func retry() {
        guard action == nil else { return }
        if retryID == nil { retryBaselineOperationID = durableRetry?.id }
        let requestID = retryID ?? UUID()
        retryID = requestID
        action = .retry
        actionError = nil
        Task {
            do {
                acceptedRetry = try await onRetry(turn.id, requestID)
            } catch {
                actionError = error.localizedDescription
            }
            action = nil
        }
    }

    private func cancel() {
        guard action == nil else { return }
        action = .cancel
        actionError = nil
        Task {
            do {
                try await onCancel(turn.id)
            } catch let error as APIError where error.status == 409 {
                actionError = "The retry has already started. Wait for the turn to refresh."
                action = nil
            } catch {
                actionError = error.localizedDescription
                action = nil
            }
        }
    }

    private func reset() {
        action = nil
        retryID = nil
        retryBaselineOperationID = nil
        acceptedRetry = nil
        actionError = nil
    }

    private enum Action {
        case retry
        case cancel
    }
}
