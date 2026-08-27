@preconcurrency import AVFoundation
import CompanionKit
import Foundation
import Observation
import UIKit

struct MicrophonePCMFrame: Sendable {
    let data: Data
    let level: Double
}

final class MicrophonePCMStream: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var continuation: AsyncStream<MicrophonePCMFrame>.Continuation?
    private var active = false
    private var tapInstalled = false

    func start() throws -> AsyncStream<MicrophonePCMFrame> {
        stop()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0,
              let outputFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: 16_000,
                channels: 1,
                interleaved: true
              ),
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw VoiceTranscriptionError.microphoneUnavailable
        }

        let (stream, continuation) = AsyncStream<MicrophonePCMFrame>.makeStream(
            bufferingPolicy: .bufferingNewest(12)
        )
        lock.withLock {
            self.converter = converter
            self.continuation = continuation
            active = true
        }

        input.installTap(
            onBus: 0,
            bufferSize: max(1, AVAudioFrameCount(inputFormat.sampleRate / 10)),
            format: inputFormat
        ) { [weak self] buffer, _ in
            self?.convert(buffer, to: outputFormat)
        }
        lock.withLock { tapInstalled = true }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            stop()
            throw VoiceTranscriptionError.microphoneUnavailable
        }
        return stream
    }

    func stop() {
        let hadTap = lock.withLock { () -> Bool in
            defer { tapInstalled = false }
            return tapInstalled
        }
        if hadTap {
            engine.inputNode.removeTap(onBus: 0)
        }
        if engine.isRunning {
            engine.stop()
        }
        let streamContinuation = lock.withLock { () -> AsyncStream<MicrophonePCMFrame>.Continuation? in
            active = false
            converter = nil
            defer { continuation = nil }
            return continuation
        }
        streamContinuation?.finish()
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: [.notifyOthersOnDeactivation]
        )
    }

    private func convert(_ input: AVAudioPCMBuffer, to outputFormat: AVAudioFormat) {
        lock.withLock {
            guard active, let converter, let continuation else { return }
            let ratio = outputFormat.sampleRate / input.format.sampleRate
            let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 1
            guard let output = AVAudioPCMBuffer(
                pcmFormat: outputFormat,
                frameCapacity: max(capacity, 1)
            ) else { return }

            var supplied = false
            var conversionError: NSError?
            let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
                guard !supplied else {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                supplied = true
                inputStatus.pointee = .haveData
                return input
            }
            guard conversionError == nil,
                  status != .error,
                  output.frameLength > 0 else { return }

            let audioBuffer = output.audioBufferList.pointee.mBuffers
            guard let bytes = audioBuffer.mData, audioBuffer.mDataByteSize > 0 else { return }
            let data = Data(bytes: bytes, count: Int(audioBuffer.mDataByteSize))
            let samples = bytes.assumingMemoryBound(to: Int16.self)
            let sampleCount = Int(audioBuffer.mDataByteSize) / MemoryLayout<Int16>.size
            var energy = 0.0
            for index in 0..<sampleCount {
                let sample = Double(samples[index]) / Double(Int16.max)
                energy += sample * sample
            }
            let rms = sampleCount > 0 ? sqrt(energy / Double(sampleCount)) : 0
            continuation.yield(.init(data: data, level: min(1, rms * 5)))
        }
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
        case connecting
        case recording
        case finishing
        case failed(String)
    }

    struct Completion: Equatable {
        let id: UUID
        let text: String
    }

    private(set) var phase: Phase = .idle
    private(set) var finalTranscript = ""
    private(set) var interimTranscript = ""
    private(set) var level = 0.0
    private(set) var startedAt: Date?
    private(set) var reconnecting = false
    private(set) var completion: Completion?

    private let client: GeminiLiveTranscriptionClient
    private let microphone: MicrophonePCMStream
    private var startTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var audioTask: Task<Void, Never>?
    private var recordingLimitTask: Task<Void, Never>?
    private var finishTask: Task<Void, Never>?
    private var generation = 0

    init(
        client: GeminiLiveTranscriptionClient = .init(),
        microphone: MicrophonePCMStream = .init()
    ) {
        self.client = client
        self.microphone = microphone
    }

    var liveTranscript: String {
        Self.join(finalTranscript, interimTranscript)
    }

    var isBusy: Bool {
        switch phase {
        case .requestingPermission, .connecting, .recording, .finishing:
            true
        case .idle, .failed:
            false
        }
    }

    var isRecording: Bool {
        phase == .recording || phase == .finishing
    }

    func start(
        session: @escaping @MainActor @Sendable () async throws -> CompanionTranscriptionSession
    ) {
        guard !isBusy else { return }
        generation &+= 1
        let activeGeneration = generation
        startTask?.cancel()
        finishTask?.cancel()
        finishTask = nil
        finalTranscript = ""
        interimTranscript = ""
        level = 0
        completion = nil
        reconnecting = false
        phase = .requestingPermission
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                guard await Self.requestMicrophonePermission() else {
                    throw VoiceTranscriptionError.permissionDenied
                }
                try Task.checkCancellation()
                phase = .connecting
                let ephemeralSession = try await session()
                try Task.checkCancellation()
                guard generation == activeGeneration else { throw CancellationError() }
                guard ephemeralSession.model == GeminiLiveTranscriptionClient.model else {
                    throw GeminiLiveTranscriptionError.invalidResponse
                }
                let events = try await client.connect(token: ephemeralSession.token)
                try Task.checkCancellation()
                guard generation == activeGeneration else {
                    await client.close()
                    throw CancellationError()
                }
                eventTask = Task { [weak self] in
                    await self?.consume(events, generation: activeGeneration)
                }
            } catch is CancellationError {
                if generation == activeGeneration { phase = .idle }
            } catch {
                await fail(error, generation: activeGeneration)
            }
        }
    }

    func stop() {
        switch phase {
        case .requestingPermission, .connecting:
            generation &+= 1
            let activeGeneration = generation
            startTask?.cancel()
            startTask = nil
            eventTask?.cancel()
            eventTask = nil
            phase = .finishing
            finishTask?.cancel()
            finishTask = Task { [weak self] in
                guard let self else { return }
                await client.close()
                guard generation == activeGeneration else { return }
                finishTask = nil
                phase = .idle
            }
        case .recording:
            let activeGeneration = generation
            phase = .finishing
            reconnecting = false
            microphone.stop()
            audioTask?.cancel()
            audioTask = nil
            recordingLimitTask?.cancel()
            recordingLimitTask = nil
            finishTask?.cancel()
            finishTask = Task { [weak self] in
                guard let self else { return }
                do {
                    try await client.finishAudio()
                    try Task.checkCancellation()
                    guard generation == activeGeneration else { return }
                } catch {
                    if error is CancellationError { return }
                    await fail(error, generation: activeGeneration)
                }
            }
        case .idle, .finishing, .failed:
            break
        }
    }

    func cancel() {
        guard phase != .idle || !liveTranscript.isEmpty || completion != nil else { return }
        generation &+= 1
        let activeGeneration = generation
        startTask?.cancel()
        startTask = nil
        eventTask?.cancel()
        eventTask = nil
        audioTask?.cancel()
        audioTask = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        finishTask?.cancel()
        finishTask = nil
        completion = nil
        finalTranscript = ""
        interimTranscript = ""
        reconnecting = false
        level = 0
        startedAt = nil
        phase = .finishing
        microphone.stop()
        finishTask = Task { [weak self] in
            guard let self else { return }
            await client.close()
            guard generation == activeGeneration else { return }
            finishTask = nil
            phase = .idle
        }
    }

    func acknowledgeCompletion() {
        completion = nil
    }

    private func consume(
        _ events: AsyncThrowingStream<GeminiLiveTranscriptionEvent, Error>,
        generation activeGeneration: Int
    ) async {
        do {
            for try await event in events {
                guard generation == activeGeneration else { return }
                switch event {
                case .ready:
                    reconnecting = false
                    if phase == .connecting {
                        try beginMicrophoneCapture(generation: activeGeneration)
                    }
                case .reconnecting:
                    reconnecting = true
                    UIAccessibility.post(
                        notification: .announcement,
                        argument: "Reconnecting to Google transcription. Recording continues."
                    )
                case .interim(let text):
                    interimTranscript = text
                case .final(let text):
                    finalTranscript = Self.mergeFinal(finalTranscript, text)
                    interimTranscript = ""
                case .completed:
                    complete(generation: activeGeneration)
                }
            }
        } catch is CancellationError {
            return
        } catch {
            await fail(error, generation: activeGeneration)
        }
    }

    private func beginMicrophoneCapture(generation activeGeneration: Int) throws {
        guard generation == activeGeneration else { throw CancellationError() }
        let frames = try microphone.start()
        startedAt = .now
        phase = .recording
        UIAccessibility.post(notification: .announcement, argument: "Recording started. Audio is sent to Google for transcription.")
        audioTask = Task { [weak self] in
            guard let self else { return }
            do {
                for await frame in frames {
                    try Task.checkCancellation()
                    guard generation == activeGeneration else { return }
                    level = frame.level
                    try await client.sendPCM16(frame.data)
                }
            } catch is CancellationError {
                return
            } catch {
                await fail(error, generation: activeGeneration)
            }
        }
        recordingLimitTask = Task { [weak self] in
            do {
                // Gemini 3.5 Transcribe Live caps a session at ten minutes. Finish with margin for
                // the final transcript and WebSocket settlement.
                try await Task.sleep(for: .seconds(9 * 60))
            } catch {
                return
            }
            guard let self, generation == activeGeneration else { return }
            stop()
        }
    }

    private func complete(generation activeGeneration: Int) {
        guard generation == activeGeneration else { return }
        microphone.stop()
        audioTask?.cancel()
        audioTask = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        finishTask?.cancel()
        finishTask = nil
        startTask = nil
        eventTask = nil
        level = 0
        reconnecting = false
        startedAt = nil
        phase = .idle
        let text = liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            completion = .init(id: UUID(), text: text)
        }
        finalTranscript = ""
        interimTranscript = ""
        UIAccessibility.post(notification: .announcement, argument: "Recording stopped. Transcript added to your message.")
    }

    private func fail(_ error: Error, generation activeGeneration: Int) async {
        guard generation == activeGeneration else { return }
        microphone.stop()
        audioTask?.cancel()
        audioTask = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        finishTask?.cancel()
        finishTask = nil
        startTask = nil
        eventTask = nil
        await client.close()
        guard generation == activeGeneration else { return }
        level = 0
        reconnecting = false
        startedAt = nil
        let partial = liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        if !partial.isEmpty {
            completion = .init(id: UUID(), text: partial)
        }
        finalTranscript = ""
        interimTranscript = ""
        let message: String
        if let apiError = error as? APIError,
           apiError.code == "provider_not_configured" {
            message = "Connect Google Gemini in Providers to use transcription."
        } else {
            message = (error as? LocalizedError)?.errorDescription
                ?? "Transcription stopped. Check your connection and try again."
        }
        phase = .failed(message)
        UIAccessibility.post(notification: .announcement, argument: message)
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

    private static func mergeFinal(_ existing: String, _ update: String) -> String {
        let next = update.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return existing }
        guard !existing.isEmpty else { return next }
        if next == existing || existing.hasSuffix(next) { return existing }
        if next.hasPrefix(existing) { return next }
        return join(existing, next)
    }

    private static func join(_ leading: String, _ trailing: String) -> String {
        let left = leading.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = trailing.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !left.isEmpty else { return right }
        guard !right.isEmpty else { return left }
        let needsSpace = !left.hasSuffix("\n") && !right.hasPrefix("\n")
        return left + (needsSpace ? " " : "") + right
    }
}
