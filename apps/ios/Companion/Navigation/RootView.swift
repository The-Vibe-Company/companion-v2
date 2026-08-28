import SwiftUI
import CompanionKit

struct RootView: View {
    private static let notificationInstallationID = NotificationInstallationIdentifier.current(
        bundleIdentifier: Bundle.main.bundleIdentifier ?? "dev.companion.mobile.dev"
    )

    @Environment(NotificationCoordinator.self) private var notifications
    @AppStorage(CompanionPreferenceKeys.notifications) private var notificationsEnabled = true
    @AppStorage(CompanionPreferenceKeys.appearance) private var appearanceValue = CompanionAppearancePreference.system.rawValue
    @State private var sessionStore = SessionStore(
        apiURL: AppConfig.apiURL,
        storage: KeychainSessionStorage(service: "\(AppConfig.callbackScheme).session"),
        notificationInstallationID: RootView.notificationInstallationID
    )
    @State private var externalOAuth = ExternalOAuthCoordinator()
    @State private var notificationTransitions = NotificationTransitionQueue()

    var body: some View {
        Group {
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-companion-appearance-demo") {
                CompanionAppearanceDemoView()
            } else if ProcessInfo.processInfo.arguments.contains("-companion-plugins-multi-account-demo") {
                NavigationStack {
                    PluginManagementView(demoModel: .linearMultiAccountDemo)
                }
            } else if ProcessInfo.processInfo.arguments.contains("-companion-queued-demo") {
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
        .environment(externalOAuth)
        .onOpenURL { url in
            _ = externalOAuth.handle(url: url)
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL else { return }
            _ = externalOAuth.handle(url: url)
        }
        .task {
#if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            guard !arguments.contains("-companion-appearance-demo"),
                  !arguments.contains("-companion-plugins-multi-account-demo"),
                  !arguments.contains("-companion-queued-demo"),
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
            enqueueNotificationTransition(enabled: notificationsEnabled, requestAuthorization: true)
        }
        .onChange(of: notificationsEnabled) { _, enabled in
            guard activeNotificationSessionID != nil else { return }
            enqueueNotificationTransition(enabled: enabled, requestAuthorization: enabled)
        }
        .onChange(of: notifications.deviceToken) { _, _ in
            guard notificationsEnabled else { return }
            enqueueNotificationTransition(enabled: true, requestAuthorization: false)
        }
        .animation(.easeOut(duration: 0.2), value: sessionStore.phase)
        .tint(.companionAccent)
        .preferredColorScheme(preferredColorScheme)
    }

    private var preferredColorScheme: ColorScheme? {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-markdown-table-dark-demo") {
            return .dark
        }
#endif
        let appearance = CompanionAppearancePreference(rawValue: appearanceValue) ?? .system
        return appearance.forcesBlackPalette ? .dark : nil
    }

    private var activeNotificationSessionID: String? {
        guard case .active(let session) = sessionStore.phase, let orgID = session.orgID else { return nil }
        return "\(orgID):\(session.user.id)"
    }

    private func enqueueNotificationTransition(enabled: Bool, requestAuthorization: Bool) {
        notificationTransitions.enqueue {
            guard activeNotificationSessionID != nil else { return }
            if enabled {
                // A later opt-out may have been queued while this transition was waiting.
                guard notificationsEnabled else { return }
                if requestAuthorization {
                    await notifications.requestAuthorizationAndRegister()
                }
                guard notificationsEnabled else { return }
                await synchronizeNotificationToken()
            } else {
                try? await sessionStore.unregisterNotificationDevice(
                    installationID: Self.notificationInstallationID
                )
                notifications.stopRemoteNotifications()
            }
        }
    }

    private func synchronizeNotificationToken() async {
        guard notificationsEnabled,
              case .active = sessionStore.phase,
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

@MainActor
private final class NotificationTransitionQueue {
    private var tail: Task<Void, Never>?

    func enqueue(_ operation: @escaping @MainActor @Sendable () async -> Void) {
        let predecessor = tail
        tail = Task { @MainActor in
            await predecessor?.value
            await operation()
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
