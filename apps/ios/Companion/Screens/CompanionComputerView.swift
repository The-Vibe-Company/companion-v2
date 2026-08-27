import CompanionKit
import Foundation
import SwiftUI
import WebKit

/// An in-memory view of the short-lived Box desktop handoff. The URL is never persisted or logged.
struct CompanionComputerView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss

    let companion: CompanionSummary
    let onSettings: () -> Void

    @State private var desktop: CompanionDesktop?
    @State private var loading = true
    @State private var error: String?
    @State private var requestGeneration = 0
    @State private var reloadToken = 0
    @State private var keyboardToken = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 12) {
                Spacer(minLength: 0)
                desktopSurface
                actionChips
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .navigationBarBackButtonHidden(true)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.black, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar { headerToolbar }
        .task(id: requestGeneration) { await connect() }
        .onDisappear { desktop = nil }
        .accessibilityIdentifier("computer.view")
    }

    @ViewBuilder
    private var desktopSurface: some View {
        if let url = desktop?.desktopURL {
            CompanionDesktopWebView(
                url: url,
                reloadToken: reloadToken,
                keyboardToken: keyboardToken,
                onFailure: { message in
                    error = message
                    desktop = nil
                    loading = false
                }
            )
            .aspectRatio(16 / 10, contentMode: .fit)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
            .clipShape(.rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.white.opacity(0.18), lineWidth: 1)
            }
            .accessibilityLabel("Live screen for \(companion.name)")
            .accessibilityIdentifier("computer.screen")
        } else if loading || desktop?.provisioning == true {
            computerState(
                title: desktop?.provisioning == true ? "Preparing computer…" : "Connecting…",
                systemImage: "desktopcomputer"
            )
        } else {
            computerState(
                title: "Computer unavailable",
                systemImage: "desktopcomputer.trianglebadge.exclamationmark"
            )
        }
    }

    @ViewBuilder
    private var actionChips: some View {
        if desktop?.desktopURL != nil {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { desktopActions }
                VStack(spacing: 8) { desktopActions }
            }
            .frame(maxWidth: .infinity)
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(.white)
        } else if !loading {
            Button("Reconnect", systemImage: "arrow.clockwise") {
                requestGeneration += 1
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(.white)
            .foregroundStyle(.black)
            .accessibilityIdentifier("computer.reconnect")
        }
    }

    @ViewBuilder
    private var desktopActions: some View {
        Button("Reconnect", systemImage: "arrow.triangle.2.circlepath") {
            requestGeneration += 1
        }
        .accessibilityIdentifier("computer.reconnect")

        Button("Reload screen", systemImage: "arrow.clockwise") {
            reloadToken += 1
        }
        .accessibilityIdentifier("computer.reload")
    }

    @ToolbarContentBuilder
    private var headerToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            computerHeaderButton(
                systemImage: "chevron.left",
                label: "Back",
                action: { dismiss() }
            )
        }

        ToolbarItem(placement: .principal) {
            Button(action: onSettings) {
                HStack(spacing: 8) {
                    CharacterMark(
                        name: companion.name,
                        icon: companion.icon,
                        size: 20
                    )
                    Text(companion.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(Color.white)
                .padding(.leading, 10)
                .padding(.trailing, 14)
                .frame(minHeight: 36)
                .background(Color.white.opacity(0.12), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Details for \(companion.name)")
            .accessibilityIdentifier("computer.details")
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
            computerHeaderButton(
                systemImage: "keyboard",
                label: "Show keyboard",
                action: { keyboardToken += 1 }
            )

            Menu {
                Button("Reconnect", systemImage: "arrow.triangle.2.circlepath") {
                    requestGeneration += 1
                }
                Button("Companion details", systemImage: "info.circle", action: onSettings)
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 44, height: 44)
                    .background(Color.white.opacity(0.12), in: Circle())
            }
            .foregroundStyle(.white)
            .accessibilityLabel("Computer actions")
            .accessibilityIdentifier("computer.actions")
        }
    }

    private func computerHeaderButton(
        systemImage: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(Color.white.opacity(0.12), in: Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .accessibilityLabel(label)
    }

    private func computerState(title: String, systemImage: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
                .foregroundStyle(.white)
        } description: {
            if let error, !loading {
                Text(error).foregroundStyle(Color.white.opacity(0.62))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .aspectRatio(16 / 10, contentMode: .fit)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }

    @MainActor
    private func connect() async {
        guard companion.access != .viewer else {
            loading = false
            error = "Viewers cannot open the Companion computer."
            desktop = nil
            return
        }
        loading = true
        error = nil
        desktop = nil
        do {
            desktop = try await sessionStore.openCompanionDesktop(companionID: companion.id)
            if desktop?.desktopURL == nil, desktop?.provisioning != true {
                error = "Send a message to start the Companion, then reconnect."
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = companionDisplayMessage(
                error,
                fallback: "The computer could not be opened."
            )
        }
        loading = false
    }
}

private struct CompanionDesktopWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    let keyboardToken: Int
    let onFailure: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFailure: onFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        context.coordinator.url = url
        context.coordinator.reloadToken = reloadToken
        context.coordinator.keyboardToken = keyboardToken
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onFailure = onFailure
        if context.coordinator.url != url {
            context.coordinator.url = url
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        if context.coordinator.reloadToken != reloadToken {
            context.coordinator.reloadToken = reloadToken
            webView.reload()
        }
        if context.coordinator.keyboardToken != keyboardToken {
            context.coordinator.keyboardToken = keyboardToken
            webView.evaluateJavaScript("document.activeElement && document.activeElement.focus()")
            webView.becomeFirstResponder()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var url: URL?
        var reloadToken = 0
        var keyboardToken = 0
        var onFailure: (String) -> Void

        init(onFailure: @escaping (String) -> Void) {
            self.onFailure = onFailure
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: any Error
        ) {
            onFailure("The live screen disconnected.")
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: any Error
        ) {
            onFailure("The live screen could not connect.")
        }
    }
}
