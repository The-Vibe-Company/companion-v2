import Foundation
import XCTest

final class CompanionUITests: XCTestCase {
    override func setUpWithError() throws {
        // Put setup code here. This method is called before the invocation of each test method in the class.

        // In UI tests it is usually best to stop immediately when a failure occurs.
        continueAfterFailure = false

        // In UI tests it’s important to set the initial state - such as interface orientation - required for your tests before they run. The setUp method is a good place to do this.
    }

    override func tearDownWithError() throws {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    @MainActor
    func testLiquidGlassDemoCanSendAMessage() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let composer = app.descendants(matching: .any)["demo.composer"]
        let send = app.buttons["demo.send"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(send.exists)

        app.buttons["Ouvrir les conversations"].tap()
        XCTAssertTrue(app.navigationBars["Conversations"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["demo.roster.inbox-triage"].exists)
        app.buttons["Fermer"].tap()

        composer.tap()
        composer.typeText("Le détail est impeccable.")
        XCTAssertTrue(send.isEnabled)
        send.tap()

        XCTAssertTrue(app.staticTexts["Le détail est impeccable."].waitForExistence(timeout: 3))
    }

    @MainActor
    func testLiquidGlassDemoRendersCompanionMarkdownSafely() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let reply = app.descendants(matching: .any)["demo.markdown.reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5))

        let heading = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.heading.")
        ).firstMatch
        let list = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.list.")
        ).firstMatch
        let quote = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.quote.")
        ).firstMatch
        let code = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.code-block.")
        ).firstMatch
        let table = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.table.")
        ).firstMatch

        XCTAssertTrue(heading.exists)
        XCTAssertTrue(list.exists)
        XCTAssertTrue(quote.exists)
        XCTAssertTrue(code.exists)
        XCTAssertTrue(table.exists)
        XCTAssertTrue(app.staticTexts["Rapport d’incident"].exists)
        XCTAssertTrue(app.staticTexts["[image: preuve distante]"].exists)
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "<img src=x onerror=alert(1)>")
        ).firstMatch.exists)

        XCTAssertTrue(app.links["Documentation sûre"].exists)
        XCTAssertFalse(app.links["Lien refusé"].exists)
        XCTAssertTrue(app.staticTexts["Lien refusé"].exists)
        XCTAssertFalse(app.images["preuve distante"].exists)

        let composer = app.descendants(matching: .any)["demo.composer"]
        let send = app.buttons["demo.send"]
        composer.tap()
        composer.typeText("**Message membre littéral**")
        send.tap()
        XCTAssertTrue(app.staticTexts["**Message membre littéral**"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testCompanionMarkdownSupportsAccessibilityTextInLandscape() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-glass-chat-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launch()
        defer {
            XCUIDevice.shared.orientation = .portrait
            app.terminate()
        }

        XCUIDevice.shared.orientation = .landscapeLeft

        let reply = app.descendants(matching: .any)["demo.markdown.reply"]
        let code = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.code-block.")
        ).firstMatch
        let table = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.table.")
        ).firstMatch

        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertTrue(code.exists)
        XCTAssertTrue(table.exists)
        try captureScreenshot(named: "chat-markdown-accessibility-landscape.png")
    }

    @MainActor
    func testCompanionMarkdownCacheInvalidatesChangedEventContent() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo", "-markdown-cache-ui-test"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Rapport d’incident"].waitForExistence(timeout: 5))

        app.buttons["Options de la conversation"].tap()
        let refresh = app.buttons["demo.markdown.refresh-cache"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 2))
        refresh.tap()

        XCTAssertTrue(app.staticTexts["Rapport actualisé"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Rapport d’incident"].exists)
        XCTAssertTrue(app.staticTexts["Le même événement affiche maintenant un contenu renouvelé."].exists)
    }

    @MainActor
    func testManagementDemoCoversCreationProvidersAndPlugins() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-management-demo"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Create a Companion"].waitForExistence(timeout: 5))
        let create = app.buttons["demo.management.create"]
        XCTAssertTrue(create.exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin-account.linear"].exists)
        create.tap()
        XCTAssertTrue(app.staticTexts["Nova is ready for her first message."].waitForExistence(timeout: 2))

        app.swipeDown()
        app.swipeDown()
        app.buttons["Providers"].tap()
        XCTAssertTrue(app.staticTexts["Model providers"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.kimi-coding"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.moonshotai"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.zai"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.openai"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.google"].exists)
        let connectProvider = app.buttons["demo.management.connect-provider"]
        XCTAssertTrue(connectProvider.exists)
        if !connectProvider.isHittable {
            app.swipeUp()
            app.swipeUp()
        }
        connectProvider.tap()
        XCTAssertTrue(app.staticTexts["Codex"].waitForExistence(timeout: 2))

        app.swipeDown()
        app.swipeDown()
        app.buttons["Plugins"].tap()
        XCTAssertTrue(app.staticTexts["Plugins"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin.linear"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin.github"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin.notion"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin.conductor"].exists)
        let addLinearAccount = app.buttons["demo.management.add-linear-account"]
        XCTAssertTrue(addLinearAccount.exists)
        if !addLinearAccount.isHittable {
            app.swipeUp()
            app.swipeUp()
        }
        addLinearAccount.tap()
        XCTAssertTrue(app.staticTexts["Linear · client"].waitForExistence(timeout: 2))
        let addPlugin = app.buttons["demo.management.add-plugin"]
        XCTAssertTrue(addPlugin.exists)
        if !addPlugin.isHittable { app.swipeUp() }
        addPlugin.tap()
        XCTAssertTrue(app.staticTexts["Knowledge MCP"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testOwnerCanOpenSettingsAndConfirmDurableDeletion() throws {
        let app = launchCompanionSettings(access: "owner")

        let delete = app.buttons["companion.settings.delete"]
        for _ in 0..<3 {
            if delete.exists { break }
            app.swipeUp()
        }
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        delete.tap()
        let confirmation = app.sheets.buttons["Delete Companion"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 2))
        confirmation.tap()

        XCTAssertTrue(app.staticTexts["Deletion requested"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["The Companion will remain visible until its Box is permanently deleted."].exists)
    }

    @MainActor
    func testEditorCanEditSettingsButCannotDelete() throws {
        let app = launchCompanionSettings(access: "editor")

        XCTAssertTrue(app.buttons["companion.settings.save"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["companion.settings.name"].isEnabled)
        XCTAssertFalse(app.buttons["companion.settings.delete"].exists)
    }

    @MainActor
    func testViewerSettingsAreReadOnly() throws {
        let app = launchCompanionSettings(access: "viewer")

        XCTAssertFalse(app.buttons["companion.settings.save"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["companion.settings.name"].isEnabled)
        XCTAssertFalse(app.buttons["companion.settings.delete"].exists)
        XCTAssertTrue(app.staticTexts["You have read-only access to this Companion."].exists)
    }

    @MainActor
    func testOwnerRosterRetriesAnAmbiguousDeleteWithTheRetainedRequest() throws {
        let app = launchCompanionRoster(access: "owner")
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]

        openRosterContextMenu(for: row, in: app)
        let delete = app.buttons["Delete Companion"]
        XCTAssertTrue(delete.exists)
        delete.tap()
        confirmRosterDeletion(in: app)

        let ambiguousMessage = "The deletion response was not received. Retry Delete safely reuses the same request."
        let ambiguousNotice = app.descendants(matching: .any)["Error. \(ambiguousMessage)"]
        XCTAssertTrue(ambiguousNotice.waitForExistence(timeout: 5))

        openRosterContextMenu(for: row, in: app)
        let retry = app.buttons["Retry Delete"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        confirmRosterDeletion(in: app)

        let acceptedMessage = "Deletion requested. The Companion will remain visible until its Box is permanently deleted."
        let acceptedNotice = app.descendants(matching: .any)[acceptedMessage]
        XCTAssertTrue(acceptedNotice.waitForExistence(timeout: 5))
    }

    @MainActor
    func testEditorRosterOffersSettingsWithoutDelete() throws {
        assertRosterContextMenu(access: "editor", canDelete: false)
    }

    @MainActor
    func testViewerRosterOffersSettingsWithoutDelete() throws {
        assertRosterContextMenu(access: "viewer", canDelete: false)
    }

    @MainActor
    private func launchCompanionSettings(access: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-settings-demo"]
        app.launchEnvironment["COMPANION_SETTINGS_DEMO_ACCESS"] = access
        app.launchEnvironment["COMPANION_API_URL"] = "http://127.0.0.1:9"
        app.launch()

        let settings = app.buttons["chat.settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Companion settings"].waitForExistence(timeout: 2))
        return app
    }

    @MainActor
    private func launchCompanionRoster(access: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-roster-demo"]
        app.launchEnvironment["COMPANION_ROSTER_DEMO_ACCESS"] = access
        app.launch()

        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        return app
    }

    @MainActor
    private func assertRosterContextMenu(access: String, canDelete: Bool) {
        let app = launchCompanionRoster(access: access)
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]
        openRosterContextMenu(for: row, in: app)

        XCTAssertEqual(app.buttons["Delete Companion"].exists, canDelete)
    }

    @MainActor
    private func openRosterContextMenu(for row: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        for _ in 0..<3 {
            if row.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(row.isHittable)
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.5)
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func confirmRosterDeletion(in app: XCUIApplication) {
        let confirmation = app.sheets.buttons["Delete Companion"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.tap()
    }

    @MainActor
    func testCompanionIconCatalogExposesEveryVariantAndState() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-icon-demo"]
        app.launch()

        XCTAssertTrue(app.navigationBars["Companion icon catalog"].waitForExistence(timeout: 5))
        try captureScreenshot(named: "catalog-top.png")

        for shape in 0..<8 {
            let element = app.descendants(matching: .any)["demo.icon.shape.\(shape)"]
            XCTAssertTrue(element.exists)
            XCTAssertTrue(element.label.contains("Companion"), "Shape \(shape) should have a Companion VoiceOver label")
        }
        for mouth in 0..<5 {
            let element = app.descendants(matching: .any)["demo.icon.mouth.\(mouth)"]
            XCTAssertTrue(element.exists)
            XCTAssertTrue(element.label.contains("Companion"), "Mouth \(mouth) should have a Companion VoiceOver label")
        }
        for accessory in 0..<7 {
            let element = app.descendants(matching: .any)["demo.icon.accessory.\(accessory)"]
            XCTAssertTrue(element.exists)
            XCTAssertTrue(element.label.contains("Companion"), "Accessory \(accessory) should have a Companion VoiceOver label")
        }

        app.swipeUp()
        app.swipeUp()
        for color in 0..<11 {
            let element = app.descendants(matching: .any)["demo.icon.color.\(color)"]
            XCTAssertTrue(element.exists)
            XCTAssertTrue(element.label.contains("Companion"), "Color \(color) should have a Companion VoiceOver label")
        }
        for (identifier, label) in [("idle", "Idle"), ("thinking", "Thinking"), ("still", "Still")] {
            let element = app.descendants(matching: .any)["demo.icon.state.\(identifier)"]
            XCTAssertTrue(element.exists)
            XCTAssertTrue(element.label.contains(label))
            XCTAssertTrue(element.label.contains("Companion"), "\(label) should have a Companion VoiceOver label")
        }
        for size in [30, 52, 86] {
            let element = app.descendants(matching: .any)["demo.icon.size.\(size)"]
            XCTAssertTrue(element.exists)
            XCTAssertTrue(element.label.contains("Companion"), "Size \(size) should have a Companion VoiceOver label")
        }

        try captureScreenshot(named: "catalog-bottom.png")

        app.terminate()

        let reducedMotionApp = XCUIApplication()
        reducedMotionApp.launchArguments = ["-companion-icon-demo", "-companion-reduce-motion"]
        reducedMotionApp.launch()

        XCTAssertTrue(reducedMotionApp.navigationBars["Companion icon catalog"].waitForExistence(timeout: 5))
        let reduceMotionIndicator = reducedMotionApp.descendants(matching: .any)["demo.icon.reduce-motion"]
        XCTAssertTrue(reduceMotionIndicator.waitForExistence(timeout: 2))
        XCTAssertEqual(reduceMotionIndicator.label, "Reduce Motion")
        XCTAssertEqual(reduceMotionIndicator.value as? String, "On")
        try captureScreenshot(named: "catalog-reduce-motion.png")
    }

    @MainActor
    func testCompanionAvatarScreenshotsAcrossDemos() throws {
        let chat = XCUIApplication()
        chat.launchArguments = ["-glass-chat-demo", "-companion-avatar-ui-evidence"]
        chat.launch()

        let composer = chat.descendants(matching: .any)["demo.composer"]
        let send = chat.buttons["demo.send"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(send.exists)
        composer.tap()
        composer.typeText("Prépare une réponse.")
        send.tap()

        let replying = chat.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "Companion écrit une réponse")
        ).firstMatch
        XCTAssertTrue(replying.waitForExistence(timeout: 2))
        XCTAssertTrue(replying.label.contains("Companion"))
        try captureScreenshot(named: "chat-thinking.png")

        let rosterButton = chat.buttons["Ouvrir les conversations"]
        XCTAssertTrue(rosterButton.waitForExistence(timeout: 2))
        rosterButton.tap()
        XCTAssertTrue(chat.navigationBars["Conversations"].waitForExistence(timeout: 2))
        let rosterEntry = chat.buttons["Companion, En ligne, Direction iOS 26 validée"]
        XCTAssertTrue(rosterEntry.waitForExistence(timeout: 2))
        XCTAssertTrue(rosterEntry.label.contains("Companion"))
        try captureScreenshot(named: "roster-idle.png")

        chat.terminate()

        let creation = XCUIApplication()
        creation.launchArguments = ["-glass-management-demo"]
        creation.launch()

        XCTAssertTrue(creation.staticTexts["Create a Companion"].waitForExistence(timeout: 5))
        let creationAvatar = creation.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Nova, Companion")
        ).firstMatch
        XCTAssertTrue(creationAvatar.waitForExistence(timeout: 2))
        XCTAssertTrue(creationAvatar.label.contains("Nova"))
        XCTAssertTrue(creationAvatar.label.contains("Companion"))
        try captureScreenshot(named: "creation-thinking.png")
    }

    @MainActor
    private func captureScreenshot(named filename: String) throws {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = filename
        attachment.lifetime = .keepAlways
        add(attachment)

        guard let directoryPath = ProcessInfo.processInfo.environment["COMPANION_SCREENSHOT_DIR"],
              !directoryPath.isEmpty else { return }

        let directoryURL = URL(fileURLWithPath: directoryPath, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        try screenshot.pngRepresentation.write(
            to: directoryURL.appendingPathComponent(filename),
            options: .atomic
        )
    }
}
