import CompanionKit
import SwiftUI

@main
struct CompanionMacApp: App {
    @State private var sessionStore: SessionStore
    @State private var desktopWindow = CompanionMacDesktopWindowState()

    init() {
        let callbackScheme = CompanionMacAppConfig.callbackScheme
        _sessionStore = State(
            initialValue: SessionStore(
                apiURL: CompanionMacAppConfig.apiURL,
                storage: KeychainSessionStorage(service: "\(callbackScheme).session")
            )
        )
    }

    var body: some Scene {
        WindowGroup("Companion", id: "companion-main") {
            CompanionMacRootView()
                .environment(sessionStore)
                .environment(desktopWindow)
        }
        .commands {
            CompanionMacCommands()
        }

        Window("Companion Desktop", id: "companion-desktop") {
            CompanionMacDesktopWindow()
                .environment(sessionStore)
                .environment(desktopWindow)
        }
        .defaultSize(width: 1_280, height: 800)
        .windowResizability(.contentSize)
    }
}
struct CompanionMacCommands: Commands {
    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Companion") {
                NotificationCenter.default.post(name: .companionMacNewCompanion, object: nil)
            }
            .keyboardShortcut("n", modifiers: [.command])
        }

        CommandGroup(after: .textEditing) {
            Button("Focus Composer") {
                NotificationCenter.default.post(name: .companionMacFocusComposer, object: nil)
            }
            .keyboardShortcut("l", modifiers: [.command])
        }

        CommandMenu("Companion") {
            Button("Open Desktop") {
                NotificationCenter.default.post(name: .companionMacOpenDesktop, object: nil)
            }
            .keyboardShortcut("d", modifiers: [.command, .shift])

            Divider()

            Button("Delete Selected Companion") {
                NotificationCenter.default.post(name: .companionMacDeleteSelected, object: nil)
            }
            .keyboardShortcut(.delete, modifiers: [.command])
        }
    }
}

extension Notification.Name {
    static let companionMacNewCompanion = Notification.Name("companion.mac.new-companion")
    static let companionMacDeleteSelected = Notification.Name("companion.mac.delete-selected")
    static let companionMacOpenDesktop = Notification.Name("companion.mac.open-desktop")
    static let companionMacFocusComposer = Notification.Name("companion.mac.focus-composer")
}
