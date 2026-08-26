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
    func testChatPhotoLibraryOpensOnFirstSelectionWithKeyboardVisible() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-settings-demo"]
        app.launchEnvironment["COMPANION_SETTINGS_DEMO_ACCESS"] = "owner"
        app.launch()

        let composer = app.descendants(matching: .any)["chat.composer"]
        let attach = app.buttons["chat.attach"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(attach.exists)

        composer.tap()
        composer.typeText("Draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))

        attach.tap()
        let photoLibrary = app.buttons["Photo library"]
        XCTAssertTrue(photoLibrary.waitForExistence(timeout: 2))
        photoLibrary.tap()

        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }

    @MainActor
    func testDecisionDemoAnswersAndApprovesRequests() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "owner"
        app.launch()

        let answerField = decisionAnswerField(in: app)
        let answer = app.buttons["decision.answer.question-1"]
        let deny = app.buttons["decision.deny.question-1"]
        XCTAssertTrue(answerField.waitForExistence(timeout: 5))
        XCTAssertTrue(answer.exists)
        XCTAssertEqual(answer.label, "Answer request")
        XCTAssertTrue(deny.exists)
        XCTAssertFalse(answer.isEnabled)

        answerField.tap()
        answerField.typeText("Ship the stable release")
        XCTAssertTrue(answer.isEnabled)
        answer.doubleTap()
        XCTAssertTrue(app.staticTexts["Submitted 1 request: question-1: answer"].waitForExistence(timeout: 2))

        let routineCard = app.descendants(matching: .any)["decision.card.routine-1"]
        for _ in 0..<4 where !routineCard.exists { app.swipeUp() }
        XCTAssertTrue(routineCard.waitForExistence(timeout: 2))
        let approveRoutine = app.buttons["decision.approve.routine-1"]
        XCTAssertTrue(approveRoutine.waitForExistence(timeout: 2))
        approveRoutine.tap()
        XCTAssertTrue(app.staticTexts["Submitted 2 request: routine-1: allow"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testDecisionDemoKeepsViewerReadOnly() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "viewer"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["decision.card.question-1"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["decision.answer.question-1"].exists)
        XCTAssertFalse(app.buttons["decision.deny.question-1"].exists)
        XCTAssertTrue(app.staticTexts["Waiting for an Owner or Editor"].exists)
    }

    @MainActor
    func testDecisionDemoSupportsAccessibilityDynamicType() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-companion-decision-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "editor"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["decision.card.question-1"].waitForExistence(timeout: 5))
        let answer = app.buttons["decision.answer.question-1"]
        for _ in 0..<3 where !answer.exists { app.swipeUp() }
        XCTAssertTrue(answer.exists)
        XCTAssertTrue(app.staticTexts["Waiting"].exists)
    }

    @MainActor
    func testDecisionDemoRendersEveryDecisionKindAndSettledState() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "editor"
        app.launch()

        for requestID in [
            "question-1", "config-1", "routine-1", "trigger-1", "shell-1", "file-1",
            "question-closed",
        ] {
            let card = app.descendants(matching: .any)["decision.card.\(requestID)"]
            for _ in 0..<6 where !card.exists { app.swipeUp() }
            XCTAssertTrue(card.waitForExistence(timeout: 2), "Missing \(requestID)")
        }
        XCTAssertTrue(app.staticTexts["Timed out, denied"].exists)
        XCTAssertTrue(app.staticTexts["Closed without approval"].exists)
    }

    @MainActor
    func testDecisionDemoOpensPluginsForAConnectionRequest() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "owner"
        app.launch()

        let openPlugins = app.buttons["decision.open-plugins.config-connect-1"]
        for _ in 0..<5 where !openPlugins.exists { app.swipeUp() }
        XCTAssertTrue(openPlugins.waitForExistence(timeout: 2))
        openPlugins.tap()
        XCTAssertTrue(app.staticTexts["Opened Plugins"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testDecisionDemoRecoversAfterAnError() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "owner"
        app.launchEnvironment["COMPANION_DECISION_DEMO_FAIL_ONCE"] = "question-1"
        app.launch()

        let answerField = decisionAnswerField(in: app)
        let answer = app.buttons["decision.answer.question-1"]
        XCTAssertTrue(answerField.waitForExistence(timeout: 5))
        answerField.tap()
        answerField.typeText("Retry this answer")
        answer.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["decision.error.question-1"]
                .waitForExistence(timeout: 2)
        )
        XCTAssertTrue(answer.isEnabled)
        answer.tap()
        XCTAssertTrue(app.staticTexts["Submitted 1 request: question-1: answer"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testInterruptedTurnDemoRetriesAndKeepsCancelAvailable() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-interruption-demo"]
        app.launchEnvironment["COMPANION_INTERRUPTION_DEMO_ACCESS"] = "owner"
        app.launch()

        XCTAssertTrue(app.staticTexts["Turn interrupted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["2 later messages are waiting behind this turn."].exists)
        let retry = app.buttons["chat.interrupted.retry"]
        let cancel = app.buttons["chat.interrupted.cancel"]
        XCTAssertTrue(retry.exists)
        XCTAssertTrue(cancel.exists)

        retry.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["chat.interrupted.retry-status"]
                .waitForExistence(timeout: 2)
        )
        XCTAssertFalse(retry.exists)
        XCTAssertTrue(cancel.exists)
    }

    @MainActor
    func testInterruptedTurnDemoCanCancelAndReleaseTheQueue() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-interruption-demo"]
        app.launchEnvironment["COMPANION_INTERRUPTION_DEMO_ACCESS"] = "editor"
        app.launch()

        let cancel = app.buttons["chat.interrupted.cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        cancel.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["interruption.demo.released"]
                .waitForExistence(timeout: 2)
        )
        XCTAssertTrue(app.staticTexts["The two waiting messages can continue in order."].exists)
    }

    @MainActor
    func testInterruptedTurnDemoKeepsViewerReadOnly() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-interruption-demo"]
        app.launchEnvironment["COMPANION_INTERRUPTION_DEMO_ACCESS"] = "viewer"
        app.launch()

        XCTAssertTrue(app.staticTexts["Turn interrupted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts[
            "An Owner or Editor must retry or cancel this turn before the conversation can continue."
        ].exists)
        XCTAssertFalse(app.buttons["chat.interrupted.retry"].exists)
        XCTAssertFalse(app.buttons["chat.interrupted.cancel"].exists)
    }

    @MainActor
    func testInterruptedTurnDemoAllowsRetryAfterAnUncertainResponse() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-interruption-demo"]
        app.launchEnvironment["COMPANION_INTERRUPTION_DEMO_ACCESS"] = "owner"
        app.launchEnvironment["COMPANION_INTERRUPTION_DEMO_FAIL_RETRY_ONCE"] = "1"
        app.launch()

        let retry = app.buttons["chat.interrupted.retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["chat.interrupted.error"]
                .waitForExistence(timeout: 2)
        )
        XCTAssertTrue(retry.isEnabled)
        retry.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["chat.interrupted.retry-status"]
                .waitForExistence(timeout: 2)
        )
    }

    @MainActor
    func testInterruptedTurnDemoUsesANewerDurableRetryAfterPollingSkipsAhead() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-interruption-demo"]
        app.launchEnvironment["COMPANION_INTERRUPTION_DEMO_ACCESS"] = "owner"
        app.launchEnvironment["COMPANION_INTERRUPTION_DEMO_SUPERSEDE_RETRY"] = "1"
        app.launch()

        let retry = app.buttons["chat.interrupted.retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        XCTAssertTrue(
            app.staticTexts["Error. A newer retry could not stay running."]
                .waitForExistence(timeout: 3)
        )
        XCTAssertTrue(retry.exists)
        XCTAssertTrue(app.buttons["chat.interrupted.cancel"].exists)
    }

    @MainActor
    func testCompanionToolRunCardShowsStatusAndExpandsLiteralDetail() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let shellCard = app.descendants(matching: .any)["demo.tool-run.shell"]
        XCTAssertTrue(shellCard.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Shell command"].exists)
        XCTAssertTrue(app.staticTexts["Done"].exists)
        XCTAssertTrue(app.staticTexts["File operation"].exists)
        XCTAssertTrue(app.staticTexts["Failed"].exists)

        let subagentCard = app.descendants(matching: .any)["demo.tool-run.subagent"]
        XCTAssertTrue(subagentCard.exists)
        let disclosure = app.buttons["tool-run.disclosure"]
        XCTAssertTrue(disclosure.exists)
        disclosure.tap()

        let detail = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Reviewing the transcript model")
        ).firstMatch
        XCTAssertTrue(detail.waitForExistence(timeout: 2))
        let showMore = app.buttons["tool-run.show-more"]
        XCTAssertTrue(showMore.exists)
        showMore.tap()
        let fullDetail = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Finishing the native tool-operation review")
        ).firstMatch
        XCTAssertTrue(fullDetail.waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["Show less detail"].exists)
        try captureScreenshot(named: "chat-tool-operations.png")
    }

    @MainActor
    private func decisionAnswerField(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(
            NSPredicate(
                format: "identifier == %@ OR label == %@",
                "decision.answer-field.question-1",
                "Answer"
            )
        ).firstMatch
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
    func testMarkdownTableDemoCoversNativeTableLayouts() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-markdown-table-demo"]
        app.launch()

        XCTAssertTrue(app.navigationBars["Markdown tables"].waitForExistence(timeout: 5))

        for fixture in ["simple", "wide", "long-content", "alignment", "single-row"] {
            let table = app.descendants(matching: .any)["markdown-table-demo.\(fixture)"]
            XCTAssertTrue(table.exists, "Missing deterministic \(fixture) table fixture")
        }

        let simpleTable = app.descendants(matching: .any)["markdown-table-demo.simple"]
        XCTAssertTrue(simpleTable.staticTexts["Simple two-column table"].exists)
        let healthyCell = simpleTable.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Status, Healthy")
        ).firstMatch
        XCTAssertTrue(healthyCell.exists)
        let simpleValueCell = simpleTable.descendants(matching: .any)[
            "markdown.table.cell.1.1"
        ]
        XCTAssertTrue(simpleValueCell.exists)
        let simpleCellHeight = simpleValueCell.frame.height

        let wideTable = app.descendants(matching: .any)["markdown-table-demo.wide"]
        let nativeWideTable = wideTable.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.table.")
        ).firstMatch
        XCTAssertTrue(nativeWideTable.exists)
        XCTAssertLessThanOrEqual(nativeWideTable.frame.maxX, app.frame.maxX + 1)
        XCTAssertGreaterThanOrEqual(nativeWideTable.frame.minX, app.frame.minX - 1)
        let trailingCell = wideTable.descendants(matching: .any)["markdown.table.cell.1.5"]
        XCTAssertTrue(trailingCell.exists)
        let trailingCellInitialX = trailingCell.frame.minX
        nativeWideTable.swipeLeft()
        XCTAssertLessThan(trailingCell.frame.minX, trailingCellInitialX)

        let longTable = app.descendants(matching: .any)["markdown-table-demo.long-content"]
        for _ in 0..<4 where !longTable.isHittable { app.swipeUp() }
        let longDetailCell = longTable.descendants(matching: .any)["markdown.table.cell.1.1"]
        XCTAssertTrue(longDetailCell.exists)
        XCTAssertGreaterThan(longDetailCell.frame.height, simpleCellHeight)

        let alignmentTable = app.descendants(matching: .any)["markdown-table-demo.alignment"]
        for _ in 0..<4 where !alignmentTable.isHittable { app.swipeUp() }
        let centerCell = alignmentTable.descendants(matching: .any)[
            "markdown.table.cell.1.1"
        ]
        let rightCell = alignmentTable.descendants(matching: .any)[
            "markdown.table.cell.1.2"
        ]
        XCTAssertEqual(centerCell.value as? String, "Center aligned")
        XCTAssertEqual(rightCell.value as? String, "Right aligned")
        XCTAssertTrue(alignmentTable.links["Beta"].exists)
        try captureScreenshot(named: "markdown-tables.png")
    }

    @MainActor
    func testMarkdownTableDemoSupportsAccessibilityTextInLandscape() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-markdown-table-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launch()
        defer {
            XCUIDevice.shared.orientation = .portrait
            app.terminate()
        }

        XCUIDevice.shared.orientation = .landscapeLeft

        let wideTable = app.descendants(matching: .any)["markdown-table-demo.wide"]
        XCTAssertTrue(wideTable.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(wideTable.frame.maxX, app.frame.maxX + 1)
        XCTAssertGreaterThanOrEqual(wideTable.frame.minX, app.frame.minX - 1)
        try captureScreenshot(named: "markdown-tables-accessibility-landscape.png")
    }

    @MainActor
    func testMarkdownTableDemoSupportsDarkAppearance() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-markdown-table-demo", "-markdown-table-dark-demo"]
        app.launch()

        let simpleTable = app.descendants(matching: .any)["markdown-table-demo.simple"]
        XCTAssertTrue(simpleTable.waitForExistence(timeout: 5))
        let healthyCell = simpleTable.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Status, Healthy")
        ).firstMatch
        XCTAssertTrue(healthyCell.exists)
        let gallery = app.descendants(matching: .any)["markdown-table-demo.gallery"]
        XCTAssertEqual(gallery.value as? String, "Dark appearance")
        try captureScreenshot(named: "markdown-tables-dark.png")
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
    func testChatOpensConnectedResourcesWithNativeResourceDetails() throws {
        let app = launchCompanionRoster(access: "viewer")
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]
        row.tap()

        let resourcesButton = app.buttons["chat.resources"]
        XCTAssertTrue(resourcesButton.waitForExistence(timeout: 5))
        XCTAssertTrue(resourcesButton.label.contains("Connected resources"))
        resourcesButton.tap()

        XCTAssertTrue(app.navigationBars["Connected resources"].waitForExistence(timeout: 2))
        let skill = app.descendants(matching: .any)[
            "companion.resources.skill.11111111-1111-4111-8111-111111111111"
        ]
        XCTAssertTrue(skill.waitForExistence(timeout: 2))
        XCTAssertTrue(skill.label.contains("Incident Summary"))
        XCTAssertTrue(skill.label.contains("Enabled"))
        XCTAssertTrue(app.descendants(matching: .any)["companion.resources.skills.hidden"].exists)

        let routine = app.descendants(matching: .any)[
            "companion.resources.routine.33333333-3333-4333-8333-333333333333"
        ]
        XCTAssertTrue(routine.exists)
        XCTAssertTrue(routine.label.contains("Weekdays at 09:00"))
        XCTAssertTrue(routine.label.contains("America/New_York"))
        XCTAssertTrue(routine.label.contains("Active"))

        let trigger = app.descendants(matching: .any)[
            "companion.resources.trigger.44444444-4444-4444-8444-444444444444"
        ]
        if !trigger.exists { app.swipeUp() }
        XCTAssertTrue(trigger.waitForExistence(timeout: 2))
        XCTAssertTrue(trigger.label.contains("GitHub"))
        XCTAssertTrue(trigger.label.contains("Webhook registered"))
        XCTAssertTrue(trigger.label.contains("Active"))
    }

    @MainActor
    func testConnectedResourcesShowsSectionEmptyStates() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-resources-demo"]
        app.launchEnvironment["COMPANION_RESOURCES_DEMO_EMPTY"] = "triggers"
        app.launch()

        XCTAssertTrue(app.navigationBars["Connected resources"].waitForExistence(timeout: 5))
        let empty = app.descendants(matching: .any)["companion.resources.triggers.empty"]
        for _ in 0..<3 where !empty.exists { app.swipeUp() }
        XCTAssertTrue(empty.waitForExistence(timeout: 2))
        XCTAssertTrue(empty.label.contains("No triggers connected"))
        XCTAssertTrue(empty.label.contains("Webhook prompts will appear here"))
    }

    @MainActor
    func testRosterContextMenuOpensConnectedResources() throws {
        let app = launchCompanionRoster(access: "editor")
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]
        openRosterContextMenu(for: row, in: app)

        let resources = app.buttons["Connected resources"]
        XCTAssertTrue(resources.waitForExistence(timeout: 2))
        resources.tap()
        XCTAssertTrue(app.navigationBars["Connected resources"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testNotificationDemoOpensTheTargetConversationAfterRosterRestore() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-roster-demo", "-companion-notification-demo"]
        app.launchEnvironment["COMPANION_API_URL"] = "http://127.0.0.1:9"
        app.launch()

        XCTAssertTrue(app.staticTexts["Conversation unavailable"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Companions"].exists)
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

        let ambiguousMessage = "Deletion could not be confirmed. Luna was restored. Retrying reuses the same request."
        let ambiguousNotice = app.descendants(matching: .any)["Error. \(ambiguousMessage)"]
        XCTAssertTrue(ambiguousNotice.waitForExistence(timeout: 5))

        openRosterContextMenu(for: row, in: app)
        let retry = app.buttons["Retry Delete"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        confirmRosterDeletion(in: app)

        XCTAssertTrue(row.waitForNonExistence(timeout: 5))
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
