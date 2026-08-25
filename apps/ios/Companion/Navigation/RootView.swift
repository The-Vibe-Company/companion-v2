import SwiftUI
import CompanionKit

struct RootView: View {
    @State private var sessionStore = SessionStore(
        apiURL: AppConfig.apiURL,
        storage: KeychainSessionStorage(service: "\(AppConfig.callbackScheme).session")
    )

    var body: some View {
        Group {
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-companion-icon-demo") {
                if ProcessInfo.processInfo.arguments.contains("-companion-reduce-motion") {
                    CompanionIconCatalogDemoView()
                        .environment(\.accessibilityReduceMotion, true)
                } else {
                    CompanionIconCatalogDemoView()
                }
            } else if ProcessInfo.processInfo.arguments.contains("-glass-chat-demo") {
                GlassChatDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-glass-management-demo-plugins") {
                GlassManagementDemoView(initialSurface: "Plugins")
            } else if ProcessInfo.processInfo.arguments.contains("-glass-management-demo") {
                GlassManagementDemoView()
            } else {
                authenticatedRoot
            }
#else
            authenticatedRoot
#endif
        }
        .environment(sessionStore)
        .task {
#if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            guard !arguments.contains("-companion-icon-demo"),
                  !arguments.contains("-glass-chat-demo"),
                  !arguments.contains("-glass-management-demo-plugins"),
                  !arguments.contains("-glass-management-demo") else { return }
#endif
            await sessionStore.restore()
        }
        .animation(.easeOut(duration: 0.24), value: sessionStore.phase)
        .tint(.companionAccent)
        .preferredColorScheme(.light)
    }

    @ViewBuilder
    private var authenticatedRoot: some View {
        Group {
            switch sessionStore.phase {
            case .restoring:
                BootstrapView(error: sessionStore.bootstrapError) {
                    Task { await sessionStore.retryRestore() }
                }
            case .signedOut:
                LoginView()
            case .onboarding(let session):
                OnboardingRequiredView(email: session.user.email)
            case .active(let session):
                CompanionListView(session: session)
            }
        }
    }
}

private struct OnboardingRequiredView: View {
    @Environment(SessionStore.self) private var sessionStore
    let email: String

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ContentUnavailableView {
                    Label("Workspace setup required", systemImage: "building.2")
                } description: {
                    Text("Finish workspace setup for \(email), then sign in again.")
                } actions: {
                    Button("Sign out") { Task { await sessionStore.signOut() } }
                        .buttonStyle(.glassProminent)
                }
                .padding(24)
            }
            .navigationTitle("Companion")
        }
    }
}
