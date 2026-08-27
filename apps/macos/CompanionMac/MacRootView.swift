import CompanionKit
import SwiftUI

struct CompanionMacRootView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(CompanionMacDesktopWindowState.self) private var desktopWindow
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        Group {
            switch sessionStore.phase {
            case .restoring:
                CompanionMacBootstrapView(error: sessionStore.bootstrapError) {
                    Task { await sessionStore.retryRestore() }
                }
            case .signedOut:
                if sessionStore.bootstrapError != nil {
                    CompanionMacBootstrapView(error: sessionStore.bootstrapError) {
                        Task { await sessionStore.retryRestore() }
                    }
                } else {
                    CompanionMacLoginView()
                }
            case .onboarding(let session):
                CompanionMacOnboardingView(session: session)
            case .active(let session):
                CompanionMacWorkspaceView(session: session, sessionStore: sessionStore)
            }
        }
        .task {
            await sessionStore.restore()
        }
        .onChange(of: sessionStore.phase) { _, phase in
            guard phase == .signedOut else { return }
            // A desktop URL is a bearer capability. Crossing the local authentication boundary
            // must tear down both the in-memory handoff and its independently hosted WebView.
            desktopWindow.clear()
            dismissWindow(id: "companion-desktop")
        }
        .tint(Color.companionMacAccent)
    }
}

struct CompanionMacBootstrapView: View {
    let error: String?
    let retry: () -> Void

    var body: some View {
        VStack(spacing: CompanionMacMetrics.space * 4) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 42, weight: .medium))
                .foregroundStyle(Color.companionMacAccent)
                .accessibilityLabel("Companion")

            VStack(spacing: CompanionMacMetrics.space) {
                Text("Companion")
                    .font(.title2.weight(.semibold))
                Text(error ?? "Restoring your session…")
                    .font(.callout)
                    .foregroundStyle(Color.companionMacMuted)
                    .multilineTextAlignment(.center)
            }

            if error == nil {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Restoring session")
            } else {
                Button("Try again", action: retry)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(CompanionMacMetrics.space * 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.companionMacCanvas)
    }
}

struct CompanionMacOnboardingView: View {
    @Environment(SessionStore.self) private var sessionStore
    let session: Session

    var body: some View {
        VStack(spacing: CompanionMacMetrics.space * 4) {
            Image(systemName: "building.2")
                .font(.system(size: 34))
                .foregroundStyle(Color.companionMacAccent)
            Text("Workspace setup required")
                .font(.title2.weight(.semibold))
            Text("Finish workspace setup for \(session.user.email), then sign in again.")
                .font(.callout)
                .foregroundStyle(Color.companionMacMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button("Sign out") {
                Task { await sessionStore.signOut() }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(CompanionMacMetrics.space * 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.companionMacCanvas)
    }
}
