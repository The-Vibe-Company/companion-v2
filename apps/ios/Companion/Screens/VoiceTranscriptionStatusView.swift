import SwiftUI

struct VoiceTranscriptionStatusView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let controller: VoiceTranscriptionController

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                statusSymbol
                Text(statusTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Spacer(minLength: 8)
                if let startedAt = controller.startedAt {
                    TimelineView(.periodic(from: startedAt, by: 1)) { context in
                        Text(duration(from: startedAt, to: context.date))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(Color.companionMuted)
                            .accessibilityLabel("Recording duration \(duration(from: startedAt, to: context.date))")
                    }
                }
            }

            if !controller.liveTranscript.isEmpty {
                Text(controller.liveTranscript)
                    .font(.subheadline)
                    .foregroundStyle(Color.companionInk)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(4)
                    .accessibilityLabel("Live transcript: \(controller.liveTranscript)")
            } else if controller.isBusy {
                Text(controller.phase == .finishing ? "Finishing transcript…" : "Start speaking when recording begins.")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
            }

            if case .failed(let message) = controller.phase {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Color.companionDanger)
                    .accessibilityLabel("Transcription error: \(message)")
            } else {
                Label("Audio is sent to Google while recording.", systemImage: "lock.shield")
                    .font(.caption)
                    .foregroundStyle(Color.companionMuted)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background {
            if reduceTransparency {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.companionCanvas)
            } else {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(.regularMaterial)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.transcription.status")
    }

    @ViewBuilder
    private var statusSymbol: some View {
        switch controller.phase {
        case .requestingPermission, .connecting, .finishing:
            ProgressView()
                .controlSize(.small)
                .tint(Color.companionDanger)
        case .recording:
            HStack(spacing: 2) {
                ForEach(0..<3, id: \.self) { index in
                    Capsule()
                        .fill(Color.companionDanger)
                        .frame(
                            width: 3,
                            height: reduceMotion
                                ? 8
                                : max(5, 5 + controller.level * Double(5 + index * 3))
                        )
                }
            }
            .frame(width: 18, height: 18)
            .accessibilityHidden(true)
        case .failed:
            Image(systemName: "mic.slash.fill")
                .foregroundStyle(Color.companionDanger)
        case .idle:
            EmptyView()
        }
    }

    private var statusTitle: String {
        switch controller.phase {
        case .idle:
            "Transcription"
        case .requestingPermission:
            "Requesting microphone access"
        case .connecting:
            "Connecting to Google"
        case .recording:
            controller.reconnecting ? "Recording · Reconnecting" : "Recording"
        case .finishing:
            "Finishing transcription"
        case .failed:
            "Transcription stopped"
        }
    }

    private func duration(from start: Date, to end: Date) -> String {
        let seconds = max(0, Int(end.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
