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

        composer.tap()
        composer.typeText("Le détail est impeccable.")
        XCTAssertTrue(send.isEnabled)
        send.tap()

        XCTAssertTrue(app.staticTexts["Le détail est impeccable."].waitForExistence(timeout: 3))
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

}
