import Foundation
import SwiftUI
import WebKit

enum CompanionPluginOAuthResult: Equatable {
    case connected
    case failed(String)
}

struct CompanionPluginOAuthBrowser: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let request: URLRequest
    let onCompletion: (CompanionPluginOAuthResult) -> Void

    @State private var loading = true

    var body: some View {
        NavigationStack {
            ZStack {
                CompanionPluginOAuthWebView(
                    request: request,
                    loading: $loading
                ) { result in
                    onCompletion(result)
                    dismiss()
                }

                if loading {
                    ProgressView("Opening \(title)…")
                        .padding(.horizontal, 18)
                        .padding(.vertical, 14)
                        .companionGlass(radius: 18)
                }
            }
            .background(Color.companionCanvas)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct CompanionPluginOAuthWebView: UIViewRepresentable {
    let request: URLRequest
    @Binding var loading: Bool
    let onCompletion: (CompanionPluginOAuthResult) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(loading: $loading, onCompletion: onCompletion)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.load(request, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private struct StartResponse: Decodable {
            let authorizationURL: URL

            enum CodingKeys: String, CodingKey {
                case authorizationURL = "authorization_url"
            }
        }

        private var loading: Binding<Bool>
        private let onCompletion: (CompanionPluginOAuthResult) -> Void
        private var followedAuthorization = false
        private var completed = false

        init(
            loading: Binding<Bool>,
            onCompletion: @escaping (CompanionPluginOAuthResult) -> Void
        ) {
            self.loading = loading
            self.onCompletion = onCompletion
        }

        func load(_ request: URLRequest, in webView: WKWebView) {
            guard let url = request.url,
                  let host = url.host,
                  let cookieHeader = request.value(forHTTPHeaderField: "Cookie") else {
                webView.load(request)
                return
            }

            let cookies = cookieHeader.split(separator: ";").compactMap { pair -> HTTPCookie? in
                let parts = pair.split(separator: "=", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespaces)
                }
                guard parts.count == 2 else { return nil }
                return HTTPCookie(properties: [
                    .domain: host,
                    .path: "/",
                    .name: parts[0],
                    .value: parts[1],
                    .secure: url.scheme == "https" ? "TRUE" : "FALSE",
                ])
            }
            guard !cookies.isEmpty else {
                webView.load(request)
                return
            }

            let pending = DispatchGroup()
            for cookie in cookies {
                pending.enter()
                webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                    pending.leave()
                }
            }
            pending.notify(queue: .main) {
                webView.load(request)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            if let result = callbackResult(for: navigationAction.request.url) {
                completed = true
                loading.wrappedValue = false
                onCompletion(result)
                return .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !completed else { return }
            loading.wrappedValue = false
            guard webView.url?.path == "/v1/companion-plugins/oauth/start",
                  !followedAuthorization else { return }

            webView.evaluateJavaScript("document.body.innerText") { [weak self, weak webView] value, _ in
                guard let self, let webView, !self.completed else { return }
                guard let text = value as? String,
                      let data = text.data(using: .utf8),
                      let response = try? JSONDecoder().decode(StartResponse.self, from: data) else {
                    self.completed = true
                    self.onCompletion(.failed("The plugin connection could not be started."))
                    return
                }
                self.followedAuthorization = true
                self.loading.wrappedValue = true
                webView.load(URLRequest(url: response.authorizationURL))
            }
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            failIfNeeded(error)
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            failIfNeeded(error)
        }

        private func callbackResult(for url: URL?) -> CompanionPluginOAuthResult? {
            guard let url,
                  url.path == "/companions",
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                return nil
            }
            let values = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map {
                ($0.name, $0.value ?? "")
            })
            if values["oauth"] == "connected" { return .connected }
            switch values["oauth_error"] {
            case "duplicate_label":
                return .failed("This plugin already has an account with that label.")
            case .some:
                return .failed("The provider did not complete authorization.")
            case .none:
                return nil
            }
        }

        private func failIfNeeded(_ error: Error) {
            guard !completed, (error as NSError).code != NSURLErrorCancelled else { return }
            completed = true
            loading.wrappedValue = false
            onCompletion(.failed("The provider page could not be loaded."))
        }
    }
}
