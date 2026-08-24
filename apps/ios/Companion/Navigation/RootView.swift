import SwiftUI
import CompanionKit

struct RootView: View {
    @State private var sessionStore = SessionStore(
        apiURL: AppConfig.apiURL,
        storage: KeychainSessionStorage(service: "\(AppConfig.callbackScheme).session")
    )

    var body: some View {
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
        .environment(sessionStore)
        .task { await sessionStore.restore() }
        .animation(.easeOut(duration: 0.24), value: sessionStore.phase)
        .tint(.companionAccent)
        .preferredColorScheme(.light)
    }
}

private struct OnboardingRequiredView: View {
    @Environment(SessionStore.self) private var sessionStore
    let email: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Workspace setup required", systemImage: "building.2")
            } description: {
                Text("Finish workspace setup for \(email), then sign in again.")
            } actions: {
                Button("Sign out") { Task { await sessionStore.signOut() } }
                    .buttonStyle(.borderedProminent)
            }
            .navigationTitle("Companion")
        }
    }
}
