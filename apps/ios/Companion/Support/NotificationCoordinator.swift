import Observation
import UIKit
import UserNotifications
import CompanionKit

@MainActor
@Observable
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    struct Destination: Equatable {
        let orgID: String
        let companionID: String
        let event: CompanionNotificationEvent
    }

    private(set) var deviceToken: String?
    private(set) var pendingDestination: Destination?
    var activeCompanionID: String?
    private let transcriptInvalidations = CompanionNotificationInvalidationQueue()

    override init() {
        super.init()
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("-companion-notification-demo") {
            pendingDestination = Destination(
                orgID: "demo-org",
                companionID: "c96ab360-00f3-4497-a51a-51442db8add1",
                event: .reply
            )
        }
#endif
    }

    func installTranscriptInvalidationHandler(
        scopeID: String,
        _ handler: @escaping CompanionNotificationInvalidationQueue.Handler,
        backgroundRefresh: @escaping CompanionNotificationInvalidationQueue.BackgroundRefreshHandler
    ) {
        transcriptInvalidations.install(
            scopeID: scopeID,
            handler,
            backgroundRefresh: backgroundRefresh
        )
    }

    func uninstallTranscriptInvalidationHandler() {
        transcriptInvalidations.uninstall()
    }

    func requestAuthorizationAndRegister() async {
        let center = UNUserNotificationCenter.current()
        var settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            settings = await center.notificationSettings()
        }
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional
                || settings.authorizationStatus == .ephemeral else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func receivedDeviceToken(_ data: Data) {
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
    }

    func stopRemoteNotifications() {
        UIApplication.shared.unregisterForRemoteNotifications()
        deviceToken = nil
    }

    func consume(_ destination: Destination) {
        if pendingDestination == destination { pendingDestination = nil }
    }

    func discardPendingDestination() {
        pendingDestination = nil
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        guard let destination = Self.destination(from: notification.request.content.userInfo) else {
            return []
        }
        guard Self.botNotificationsEnabled(for: destination.companionID) else { return [] }
        let isOpen = await MainActor.run {
            requestTranscriptInvalidation(for: destination)
            return activeCompanionID == destination.companionID
        }
        return isOpen ? [] : [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let destination = Self.destination(from: response.notification.request.content.userInfo) else {
            return
        }
        guard Self.botNotificationsEnabled(for: destination.companionID) else { return }
        await MainActor.run { pendingDestination = destination }
    }

    nonisolated static func destination(from userInfo: [AnyHashable: Any]) -> Destination? {
        let version = (userInfo["version"] as? NSNumber)?.intValue
            ?? Int(userInfo["version"] as? String ?? "")
        guard version == 1,
              let orgID = userInfo["org_id"] as? String,
              let companionID = userInfo["companion_id"] as? String,
              let eventValue = userInfo["event"] as? String,
              let event = CompanionNotificationEvent(rawValue: eventValue) else { return nil }
        return Destination(orgID: orgID, companionID: companionID, event: event)
    }

    nonisolated private static func botNotificationsEnabled(for companionID: String) -> Bool {
        let key = CompanionPreferenceKeys.notificationPrefix + companionID
        guard UserDefaults.standard.object(forKey: key) != nil else { return true }
        return UserDefaults.standard.bool(forKey: key)
    }

    func requestTranscriptInvalidation(for destination: Destination) {
        transcriptInvalidations.invalidate(
            scopeID: destination.orgID,
            companionID: destination.companionID
        )
    }

    func refreshTranscriptInBackground(for destination: Destination) async -> CompanionCacheRefreshResult {
        await transcriptInvalidations.refresh(
            scopeID: destination.orgID,
            companionID: destination.companionID
        )
    }
}

@MainActor
final class NotificationAppDelegate: NSObject, UIApplicationDelegate {
    let notifications = NotificationCoordinator()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = notifications
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        notifications.receivedDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let destination = NotificationCoordinator.destination(from: userInfo) else {
            completionHandler(.noData)
            return
        }
        Task { @MainActor [notifications] in
            let result = await notifications.refreshTranscriptInBackground(for: destination)
            completionHandler(Self.backgroundFetchResult(for: result))
        }
    }

    private static func backgroundFetchResult(
        for result: CompanionCacheRefreshResult
    ) -> UIBackgroundFetchResult {
        switch result {
        case .newData: return .newData
        case .noData: return .noData
        case .failed: return .failed
        }
    }
}
