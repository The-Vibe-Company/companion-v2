@preconcurrency import AVFoundation
import CompanionKit
import Foundation
import Observation
import UIKit

@MainActor
final class MicrophoneAACRecorder {
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?

    func start() throws {
        cancel()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("companion-dictation-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.prepareToRecord(), recorder.record() else {
                throw VoiceTranscriptionError.microphoneUnavailable
            }
            self.recorder = recorder
            recordingURL = url
        } catch {
            try? FileManager.default.removeItem(at: url)
            try? session.setActive(false, options: [.notifyOthersOnDeactivation])
            throw VoiceTranscriptionError.microphoneUnavailable
        }
    }

    func stop() throws -> Data {
        guard let recorder, let recordingURL else {
            throw VoiceTranscriptionError.microphoneUnavailable
        }
        recorder.stop()
        self.recorder = nil
        self.recordingURL = nil
        defer {
            try? FileManager.default.removeItem(at: recordingURL)
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: [.notifyOthersOnDeactivation]
            )
        }
        let data = try Data(contentsOf: recordingURL, options: .mappedIfSafe)
        guard !data.isEmpty else { throw CompanionTranscriptionError.emptyAudio }
        return data
    }

    func cancel() {
        recorder?.stop()
        recorder = nil
        if let recordingURL {
            try? FileManager.default.removeItem(at: recordingURL)
        }
        recordingURL = nil
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: [.notifyOthersOnDeactivation]
        )
    }

    func level() -> Double {
        guard let recorder, recorder.isRecording else { return 0 }
        recorder.updateMeters()
        let amplitude = pow(10, Double(recorder.averagePower(forChannel: 0)) / 20)
        return min(1, amplitude * 5)
    }
}

enum VoiceTranscriptionError: Error, LocalizedError {
    case permissionDenied
    case microphoneUnavailable

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            "Microphone access is off. Enable it in Settings to dictate a message."
        case .microphoneUnavailable:
            "The microphone is unavailable. Check the audio input and try again."
        }
    }
}

@MainActor
@Observable
final class VoiceTranscriptionController {
    enum Phase: Equatable {
        case idle
        case requestingPermission
        case recording
        case processing
        case failed(String)
    }

    struct Completion: Equatable {
        let id: UUID
        let text: String
    }

    private(set) var phase: Phase = .idle
    private(set) var level = 0.0
    private(set) var startedAt: Date?
    private(set) var completion: Completion?

    private let microphone: MicrophoneAACRecorder
    private var startTask: Task<Void, Never>?
    private var meterTask: Task<Void, Never>?
    private var recordingLimitTask: Task<Void, Never>?
    private var transcriptionTask: Task<Void, Never>?
    private var transcribe: (@MainActor @Sendable (Data) async throws -> CompanionTranscription)?
    private var generation = 0

    init(microphone: MicrophoneAACRecorder = .init()) {
        self.microphone = microphone
    }

    var isBusy: Bool {
        switch phase {
        case .requestingPermission, .recording, .processing:
            true
        case .idle, .failed:
            false
        }
    }

    var isRecording: Bool { phase == .recording }

    func start(
        transcribe: @escaping @MainActor @Sendable (Data) async throws -> CompanionTranscription
    ) {
        guard !isBusy else { return }
        generation &+= 1
        let activeGeneration = generation
        cancelTasks()
        completion = nil
        level = 0
        startedAt = nil
        self.transcribe = transcribe
        phase = .requestingPermission
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                guard await Self.requestMicrophonePermission() else {
                    throw VoiceTranscriptionError.permissionDenied
                }
                try Task.checkCancellation()
                guard generation == activeGeneration else { throw CancellationError() }
                try microphone.start()
                startedAt = .now
                phase = .recording
                startMeter(generation: activeGeneration)
                startRecordingLimit(generation: activeGeneration)
                UIAccessibility.post(
                    notification: .announcement,
                    argument: "Recording started. The transcript will be processed after recording stops."
                )
            } catch is CancellationError {
                if generation == activeGeneration { phase = .idle }
            } catch {
                fail(error, generation: activeGeneration)
            }
        }
    }

    func stop() {
        switch phase {
        case .requestingPermission:
            cancel()
        case .recording:
            let activeGeneration = generation
            meterTask?.cancel()
            meterTask = nil
            recordingLimitTask?.cancel()
            recordingLimitTask = nil
            level = 0
            startedAt = nil
            do {
                let audio = try microphone.stop()
                guard let transcribe else { throw VoiceTranscriptionError.microphoneUnavailable }
                phase = .processing
                transcriptionTask?.cancel()
                transcriptionTask = Task { [weak self] in
                    guard let self else { return }
                    do {
                        let result = try await transcribe(audio)
                        try Task.checkCancellation()
                        complete(result.transcript, generation: activeGeneration)
                    } catch is CancellationError {
                        return
                    } catch {
                        fail(error, generation: activeGeneration)
                    }
                }
            } catch {
                fail(error, generation: activeGeneration)
            }
        case .idle, .processing, .failed:
            break
        }
    }

    func cancel() {
        guard phase != .idle || completion != nil else { return }
        generation &+= 1
        cancelTasks()
        microphone.cancel()
        transcribe = nil
        completion = nil
        level = 0
        startedAt = nil
        phase = .idle
    }

    func acknowledgeCompletion() {
        completion = nil
    }

    private func startMeter(generation activeGeneration: Int) {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, generation == activeGeneration, phase == .recording else { return }
                level = microphone.level()
            }
        }
    }

    private func startRecordingLimit(generation activeGeneration: Int) {
        recordingLimitTask?.cancel()
        recordingLimitTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(9 * 60))
            } catch {
                return
            }
            guard let self, generation == activeGeneration else { return }
            stop()
        }
    }

    private func complete(_ value: String, generation activeGeneration: Int) {
        guard generation == activeGeneration else { return }
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        cancelTasks()
        transcribe = nil
        phase = .idle
        if !text.isEmpty {
            completion = .init(id: UUID(), text: text)
        }
        UIAccessibility.post(
            notification: .announcement,
            argument: "Recording processed. Transcript added to your message."
        )
    }

    private func fail(_ error: Error, generation activeGeneration: Int) {
        guard generation == activeGeneration else { return }
        cancelTasks()
        microphone.cancel()
        transcribe = nil
        level = 0
        startedAt = nil
        let message: String
        if let apiError = error as? APIError,
           apiError.code == "provider_not_configured" {
            message = "Voice transcription is not configured for this deployment."
        } else {
            message = (error as? LocalizedError)?.errorDescription
                ?? "Transcription stopped. Check your connection and try again."
        }
        phase = .failed(message)
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    private func cancelTasks() {
        startTask?.cancel()
        startTask = nil
        meterTask?.cancel()
        meterTask = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        transcriptionTask?.cancel()
        transcriptionTask = nil
    }

    private static func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await AVAudioApplication.requestRecordPermission()
        @unknown default:
            return false
        }
    }
}
