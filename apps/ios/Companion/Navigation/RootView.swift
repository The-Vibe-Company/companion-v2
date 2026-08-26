import SwiftUI
import CompanionKit

struct RootView: View {
    private static let notificationInstallationID = NotificationInstallationIdentifier.current(
        bundleIdentifier: Bundle.main.bundleIdentifier ?? "dev.companion.mobile.dev"
    )

    @Environment(NotificationCoordinator.self) private var notifications
    @State private var sessionStore = SessionStore(
        apiURL: AppConfig.apiURL,
        storage: KeychainSessionStorage(service: "\(AppConfig.callbackScheme).session"),
        notificationInstallationID: RootView.notificationInstallationID
    )

    var body: some View {
        Group {
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-companion-queued-demo") {
                CompanionQueuedMessagesDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-markdown-table-demo") {
                MarkdownTableDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-companion-interruption-demo") {
                CompanionInterruptedTurnDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-companion-transcript-window-demo") {
                CompanionTranscriptWindowDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-companion-decision-demo") {
                CompanionDecisionDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-companion-icon-demo") {
                CompanionIconCatalogDemoView(
                    forceReduceMotion: ProcessInfo.processInfo.arguments.contains("-companion-reduce-motion")
                )
            } else if ProcessInfo.processInfo.arguments.contains("-companion-create-demo") {
                CreateCompanionDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-companion-resources-demo") {
                CompanionConnectedResourcesDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-glass-chat-demo") {
                GlassChatDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-companion-settings-demo") {
                CompanionSettingsDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-companion-roster-demo") {
                CompanionRosterDemoView()
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
            guard !arguments.contains("-companion-queued-demo"),
                  !arguments.contains("-markdown-table-demo"),
                  !arguments.contains("-companion-interruption-demo"),
                  !arguments.contains("-companion-transcript-window-demo"),
                  !arguments.contains("-companion-decision-demo"),
                  !arguments.contains("-companion-icon-demo"),
                  !arguments.contains("-companion-create-demo"),
                  !arguments.contains("-companion-resources-demo"),
                  !arguments.contains("-glass-chat-demo"),
                  !arguments.contains("-companion-settings-demo"),
                  !arguments.contains("-companion-roster-demo"),
                  !arguments.contains("-glass-management-demo-plugins"),
                  !arguments.contains("-glass-management-demo") else { return }
#endif
            await sessionStore.restore()
        }
        .task(id: activeNotificationSessionID) {
            guard activeNotificationSessionID != nil else { return }
            await notifications.requestAuthorizationAndRegister()
            await synchronizeNotificationToken()
        }
        .onChange(of: notifications.deviceToken) { _, _ in
            Task { await synchronizeNotificationToken() }
        }
        .animation(.easeOut(duration: 0.24), value: sessionStore.phase)
        .tint(.companionAccent)
        .preferredColorScheme(preferredColorScheme)
    }

    private var preferredColorScheme: ColorScheme? {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-markdown-table-dark-demo") {
            return .dark
        }
#endif
        return nil
    }

    private var activeNotificationSessionID: String? {
        guard case .active(let session) = sessionStore.phase, let orgID = session.orgID else { return nil }
        return "\(orgID):\(session.user.id)"
    }

    private func synchronizeNotificationToken() async {
        guard case .active = sessionStore.phase,
              let token = notifications.deviceToken,
              let bundleID = Bundle.main.bundleIdentifier else { return }
        let environment: NotificationDeviceRegistration.Environment
        switch bundleID {
        case "dev.companion.mobile.dev": environment = .sandbox
        case "dev.companion.mobile": environment = .production
        default: return
        }
        try? await sessionStore.registerNotificationDevice(
            installationID: RootView.notificationInstallationID,
            registration: NotificationDeviceRegistration(
                deviceToken: token,
                environment: environment,
                bundleID: bundleID
            )
        )
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
