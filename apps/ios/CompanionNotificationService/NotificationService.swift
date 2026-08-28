import CompanionNotificationAvatar
import Foundation
import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let completionLock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let original = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.contentHandler = contentHandler
        bestAttemptContent = original

        guard request.content.userInfo["event"] as? String == "reply",
              let companionID = request.content.userInfo["companion_id"] as? String,
              let companionName = request.content.userInfo["companion_name"] as? String,
              let mark = CompanionNotificationMark(apnsUserInfo: request.content.userInfo),
              let avatarData = try? CompanionNotificationAvatar.pngData(for: mark) else {
            finish(with: original)
            return
        }

        let attachmentFallback = original.mutableCopy() as? UNMutableNotificationContent ?? original
        if let attachment = makeAttachment(data: avatarData) {
            attachmentFallback.attachments = [attachment]
            bestAttemptContent = attachmentFallback
        }

        let handle = INPersonHandle(value: companionID, type: .unknown)
        let sender = INPerson(
            personHandle: handle,
            nameComponents: nil,
            displayName: companionName,
            image: INImage(imageData: avatarData),
            contactIdentifier: nil,
            customIdentifier: companionID,
            isMe: false,
            suggestionType: .none
        )
        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: original.body,
            speakableGroupName: nil,
            conversationIdentifier: companionID,
            serviceName: "Companion",
            sender: sender,
            attachments: nil
        )
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { [weak self] error in
            guard let self else { return }
            guard error == nil, let enriched = try? original.updating(from: intent) else {
                self.finish(with: attachmentFallback)
                return
            }
            self.finish(with: enriched)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        finishWithBestAttemptContent()
    }

    private func makeAttachment(data: Data) -> UNNotificationAttachment? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("png")
        do {
            try data.write(to: url, options: .atomic)
            return try UNNotificationAttachment(identifier: "companion-avatar", url: url)
        } catch {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    private func finish(with content: UNNotificationContent) {
        completionLock.lock()
        let handler = contentHandler
        contentHandler = nil
        bestAttemptContent = nil
        completionLock.unlock()
        handler?(content)
    }

    private func finishWithBestAttemptContent() {
        completionLock.lock()
        let handler = contentHandler
        let content = bestAttemptContent
        contentHandler = nil
        bestAttemptContent = nil
        completionLock.unlock()
        if let handler, let content {
            handler(content)
        }
    }
}
