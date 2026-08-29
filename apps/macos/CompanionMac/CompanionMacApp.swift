import CompanionKit
import AppKit
import SwiftUI

@main
struct CompanionMacApp: App {
    @State private var sessionStore: SessionStore
    @State private var desktopWindow = CompanionMacDesktopWindowState()
    @AppStorage(CompanionPreferenceKeys.appearance) private var appearanceValue = CompanionAppearancePreference.system.rawValue

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
                .preferredColorScheme(preferredColorScheme)
                .background(CompanionMacWindowFrameAutosaver())
        }
        .defaultSize(width: 1_440, height: 900)
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

    private var preferredColorScheme: ColorScheme? {
        let appearance = CompanionAppearancePreference(rawValue: appearanceValue) ?? .system
        return appearance.forcesBlackPalette ? .dark : nil
    }
}
struct CompanionMacCommands: Commands {
    @AppStorage(CompanionPreferenceKeys.appearance) private var appearanceValue = CompanionAppearancePreference.system.rawValue

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

        CommandMenu("Appearance") {
            ForEach(CompanionAppearancePreference.allCases, id: \.self) { preference in
                Button {
                    appearanceValue = preference.rawValue
                } label: {
                    if appearanceValue == preference.rawValue {
                        Label(preference.label, systemImage: "checkmark")
                    } else {
                        Text(preference.label)
                    }
                }
            }
        }
    }
}

private struct CompanionMacWindowFrameAutosaver: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        FrameAutosaveView()
    }

    func updateNSView(_ nsView: NSView, context: Context) { }

    private final class FrameAutosaveView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window?.setFrameAutosaveName("CompanionMac.MainWindow")
            window?.minSize = NSSize(width: 860, height: 620)
        }
    }
}

extension Notification.Name {
    static let companionMacNewCompanion = Notification.Name("companion.mac.new-companion")
    static let companionMacDeleteSelected = Notification.Name("companion.mac.delete-selected")
    static let companionMacOpenDesktop = Notification.Name("companion.mac.open-desktop")
    static let companionMacFocusComposer = Notification.Name("companion.mac.focus-composer")
}
