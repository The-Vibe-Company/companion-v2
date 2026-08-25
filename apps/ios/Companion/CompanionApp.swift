import SwiftUI
import CompanionKit

@main
struct CompanionApp: App {
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appDelegate.notifications)
        }
    }
}
