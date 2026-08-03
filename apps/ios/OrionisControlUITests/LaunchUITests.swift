import XCTest

/// UI tests run against a real build with no gateway configured, so they
/// exercise the first-launch and unconfigured paths without a server.
final class LaunchUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"] + arguments
        // Start from a clean slate so the welcome flow is deterministic.
        app.launchArguments += ["-com.apple.CoreData.SQLDebug", "0"]
        app.launch()
        return app
    }

    func testFirstLaunchShowsWelcomeAndExplainsPrivacy() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["Orionis Control"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["No analytics, no tracking"].exists)
        XCTAssertTrue(app.buttons["Get started"].exists)
    }

    func testGettingStartedRevealsTheGatewayField() {
        let app = launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 10))
        app.buttons["Get started"].tap()

        let field = app.textFields["Gateway address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Test connection"].exists)
        // Nothing may proceed until an address is entered.
        XCTAssertFalse(app.buttons["Test connection"].isEnabled)
    }

    func testUnreachableGatewayProducesAnActionableError() {
        let app = launch()
        app.buttons["Get started"].tap()

        let field = app.textFields["Gateway address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("gateway.invalid")

        app.buttons["Test connection"].tap()

        // A host that cannot resolve is different from a device with no network
        // and must not be rendered as a nonsense HTTP status such as -1003.
        XCTAssertTrue(app.staticTexts["Gateway unavailable"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.descendants(matching: .any)["error-summary"].exists)
    }

    func testWelcomeScreenSupportsLargeDynamicType() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityL"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Orionis Control"].waitForExistence(timeout: 10))
        // The primary action must remain reachable at accessibility text sizes.
        XCTAssertTrue(app.buttons["Get started"].exists)
        XCTAssertTrue(app.buttons["Get started"].isHittable)
    }

    func testNoPasswordFieldIsEverPresented() {
        let app = launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 10))
        app.buttons["Get started"].tap()
        // The app must never collect identity-provider credentials itself.
        XCTAssertEqual(app.secureTextFields.count, 0)
    }
}
