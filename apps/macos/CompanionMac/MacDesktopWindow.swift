import AppKit
import CompanionKit
import Observation
import SwiftUI
import WebKit

@MainActor
@Observable
final class CompanionMacDesktopWindowState {
    private(set) var companionID: String?
    private(set) var companionName = "Companion"
    private(set) var access: CompanionAccess = .viewer
    private(set) var desktopURL: URL?
    private(set) var provisioning = false
    private(set) var transportLabel: String?
    private(set) var phase: CompanionMacDesktopPhase = .empty
    private(set) var errorMessage: String?
    private(set) var requestGeneration = 0

    var canOperate: Bool {
        access.canEditCompanionSettings && companionID != nil
    }

    func begin(
        companionID: String,
        companionName: String,
        access: CompanionAccess
    ) {
        self.companionID = companionID
        self.companionName = companionName
        self.access = access
        requestGeneration += 1
        request()
    }

    func request() {
        desktopURL = nil
        provisioning = false
        transportLabel = nil
        errorMessage = nil
        phase = .requesting
    }

    func install(_ desktop: CompanionDesktop) {
        // The model is intentionally copied into short-lived memory only. In particular, do not
        // write this URL to UserDefaults, a log, a pasteboard, or a restoration activity.
        desktopURL = desktop.desktopURL
        provisioning = desktop.provisioning
        transportLabel = desktop.transport.map { String(describing: $0) }
        errorMessage = nil
        phase = desktop.desktopURL == nil
            ? (desktop.provisioning ? .provisioning : .failed)
            : .loaded
    }

    func fail() {
        desktopURL = nil
        provisioning = false
        transportLabel = nil
        errorMessage = "The Box desktop is temporarily unavailable. Make sure the Box is running, then reconnect."
        phase = .failed
    }

    func clear() {
        companionID = nil
        companionName = "Companion"
        access = .viewer
        desktopURL = nil
        provisioning = false
        transportLabel = nil
        errorMessage = nil
        phase = .empty
        requestGeneration = 0
    }
}

struct CompanionMacDesktopWindow: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(CompanionMacDesktopWindowState.self) private var desktopWindow
    @State private var loading = false
    @State private var webViewError: String?

    var body: some View {
        Group {
            if let url = desktopWindow.desktopURL,
               desktopWindow.phase == .loaded,
               let safeURL = validatedDesktopURL(url) {
                CompanionMacWebView(url: safeURL) {
                    webViewError = "The desktop connection was interrupted. Reconnect to mint a fresh handoff."
                }
                .overlay(alignment: .bottom) {
                    if let webViewError {
                        CompanionMacErrorNotice(message: webViewError)
                            .padding(CompanionMacMetrics.space * 3)
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(minWidth: 880, minHeight: 560)
        .background(Color.companionMacCanvas)
        .navigationTitle(desktopWindow.companionName)
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    Task { await reconnect() }
                } label: {
                    if loading {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Reconnect", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(loading || !desktopWindow.canOperate)
                .accessibilityIdentifier("desktop.reconnect")
            }
        }
        .task(id: desktopWindow.requestGeneration) {
            // A Window scene can be opened by a menu item before its content has rendered. Do not
            // contact the runtime here: only a toolbar action from an authorized handoff may mint
            // a desktop URL.
            if desktopWindow.phase == .requesting {
                await reconnect()
            }
        }
        .onDisappear {
            desktopWindow.clear()
        }
    }

    private var placeholder: some View {
        VStack(spacing: CompanionMacMetrics.space * 3) {
            Image(systemName: desktopWindow.provisioning ? "hourglass" : "display")
                .font(.system(size: 36))
                .foregroundStyle(Color.companionMacAccent)

            Text(title)
                .font(.title3.weight(.semibold))
            Text(detail)
                .font(.callout)
                .foregroundStyle(Color.companionMacMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 480)

            if desktopWindow.canOperate, desktopWindow.phase != .requesting {
                Button("Reconnect", systemImage: "arrow.clockwise") {
                    Task { await reconnect() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(CompanionMacMetrics.space * 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var title: String {
        if !desktopWindow.canOperate { return "Desktop unavailable" }
        switch desktopWindow.phase {
        case .requesting: return "Connecting to desktop…"
        case .provisioning: return "Desktop is provisioning"
        case .failed: return "Could not connect"
        case .empty, .loaded: return "Desktop unavailable"
        }
    }

    private var detail: String {
        if !desktopWindow.canOperate {
            return "Only an Owner or Editor can open a running Box desktop."
        }
        if let error = desktopWindow.errorMessage { return error }
        if desktopWindow.provisioning {
            return "The Box is preparing its desktop stream. Reconnect when it is ready."
        }
        return "The desktop handoff is short-lived. Reconnect to mint a fresh one."
    }

    private func reconnect() async {
        guard !loading, desktopWindow.canOperate, let companionID = desktopWindow.companionID else { return }
        loading = true
        webViewError = nil
        desktopWindow.request()
        do {
            // This endpoint is a read-only observation of an already-running Box. It never starts
            // a Box and the returned signed URL is held only in the dedicated window state.
            let desktop = try await sessionStore.openCompanionDesktop(companionID: companionID)
            desktopWindow.install(desktop)
        } catch {
            desktopWindow.fail()
        }
        loading = false
    }

    private func validatedDesktopURL(_ url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(),
              (scheme == "https" || scheme == "http"),
              url.host != nil else {
            return nil
        }
        return url
    }
}

private struct CompanionMacWebView: NSViewRepresentable {
    let url: URL
    let onFailure: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFailure: onFailure)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsMagnification = true
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard webView.url != url else { return }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let onFailure: () -> Void

        init(onFailure: @escaping () -> Void) {
            self.onFailure = onFailure
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onFailure()
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            onFailure()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url,
                  let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http" else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
