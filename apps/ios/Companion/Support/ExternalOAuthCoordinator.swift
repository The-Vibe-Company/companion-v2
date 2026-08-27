import CompanionKit
import Observation
import UIKit

/// Owns the short-lived handoff between the app and the user's default browser.
///
/// Callback URLs are kept only in memory until the corresponding CompanionKit API call consumes
/// them. A callback is accepted only when its matching flow is still pending; unrelated URL opens
/// therefore remain outside the app's authentication boundary.
@MainActor
@Observable
final class ExternalOAuthCoordinator {
    enum Flow: Equatable {
        case google(callbackScheme: String, nativeState: String)
        case plugin(callbackURL: URL, callbackState: String)

        var googleNativeState: String? {
            if case .google(_, let nativeState) = self { return nativeState }
            return nil
        }

        var isGoogle: Bool {
            if case .google = self { return true }
            return false
        }

        var isPlugin: Bool {
            if case .plugin = self { return true }
            return false
        }
    }

    enum Phase: Equatable {
        case idle
        case waiting
        case completing
        case timedOut
        case failed(String)
    }

    private(set) var activeFlow: Flow? = nil
    private(set) var phase: Phase = .idle
    private(set) var callbackGeneration = 0

    private var pendingURL: URL?
    private var callbackURL: URL?
    private var flowID = UUID()
    private var timeoutTask: Task<Void, Never>?

    func beginGoogle(proxyURL: URL, callbackScheme: String, nativeState: String) {
        begin(
            flow: .google(callbackScheme: callbackScheme, nativeState: nativeState),
            url: proxyURL
        )
    }

    @discardableResult
    func beginPlugin(authorizationURL: URL) -> Bool {
        guard let rawCallbackURL = CompanionOAuthCallbackPolicy.queryValue(
            named: "redirect_uri",
            from: authorizationURL
        ),
              let callbackURL = URL(string: rawCallbackURL),
              let callbackState = CompanionOAuthCallbackPolicy.queryValue(
                  named: "state",
                  from: authorizationURL
              ),
              !callbackState.isEmpty,
              CompanionOAuthCallbackPolicy.isPluginCallback(
                  callbackURL,
                  expectedCallbackURL: callbackURL
              ) else {
            return false
        }
        begin(
            flow: .plugin(callbackURL: callbackURL, callbackState: callbackState),
            url: authorizationURL
        )
        return true
    }

    /// Routes a URL delivered by `onOpenURL` or a Universal Link scene event.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let activeFlow, phase != .completing, callbackURL == nil else { return false }
        let route: CompanionOAuthCallbackRoute
        switch activeFlow {
        case .google(let callbackScheme, let nativeState):
            route = CompanionOAuthCallbackPolicy.route(
                for: url,
                googleCallbackScheme: callbackScheme,
                googleNativeState: nativeState
            )
            guard route == .google else { return false }
        case .plugin(let expectedCallbackURL, let expectedState):
            route = CompanionOAuthCallbackPolicy.route(
                for: url,
                googleCallbackScheme: nil,
                pluginCallbackURL: expectedCallbackURL,
                pluginCallbackState: expectedState
            )
            guard route == .plugin else { return false }
        }

        callbackURL = url
        phase = .completing
        callbackGeneration += 1
        timeoutTask?.cancel()
        timeoutTask = nil
        return true
    }

    /// Removes the one callback currently waiting for a CompanionKit completion call.
    func takeCallback() -> URL? {
        let callback = callbackURL
        callbackURL = nil
        return callback
    }

    /// Opens the same pending authorization URL again. Plugin callers reuse the same server flow
    /// and callback cookie after this UI-only timeout.
    func reopen() {
        guard activeFlow != nil, pendingURL != nil, callbackURL == nil else { return }
        phase = .waiting
        scheduleTimeout()
        openPendingURL()
    }

    func cancel() {
        clearPendingState()
        phase = .idle
    }

    func completeSuccessfully() {
        clearPendingState()
        phase = .idle
    }

    func fail(_ message: String) {
        clearPendingState()
        phase = .failed(message)
    }

    private func begin(flow: Flow, url: URL) {
        // Starting another flow invalidates any callback URL, authorization state, and timeout
        // associated with the previous one before the new browser handoff begins.
        clearPendingState()
        activeFlow = flow
        pendingURL = url
        phase = .waiting
        flowID = UUID()
        scheduleTimeout()
        openPendingURL()
    }

    private func scheduleTimeout() {
        timeoutTask?.cancel()
        let currentFlowID = flowID
        timeoutTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(120))
            } catch {
                return
            }
            guard let self,
                  self.flowID == currentFlowID,
                  self.activeFlow != nil,
                  self.callbackURL == nil else {
                return
            }
            self.phase = .timedOut
        }
    }

    private func openPendingURL() {
        guard let pendingURL else { return }
        let currentFlowID = flowID
        UIApplication.shared.open(pendingURL, options: [:]) { opened in
            guard !opened else { return }
            Task { @MainActor [weak self] in
                guard let self,
                      self.flowID == currentFlowID,
                      self.pendingURL != nil,
                      self.callbackURL == nil else { return }
                self.phase = .failed(
                    "The authorization page could not be opened. Tap Reopen to try again."
                )
            }
        }
    }

    private func clearPendingState() {
        timeoutTask?.cancel()
        timeoutTask = nil
        activeFlow = nil
        pendingURL = nil
        callbackURL = nil
        flowID = UUID()
    }
}
