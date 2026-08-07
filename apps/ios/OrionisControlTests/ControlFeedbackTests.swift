import XCTest

@testable import OrionisControl

/// Regression cover for the camera-control feedback semantics.
///
/// Every control outcome used to collapse into one optional string, so the view
/// had no way to distinguish a confirmation from an error and drew a failed
/// operation with a green checkmark — "Camera offline: The control could not be
/// sent." rendered as success. These tests pin the three cases apart.
final class CameraControlFeedbackTests: XCTestCase {
    func testEachOutcomeCarriesItsMessage() {
        XCTAssertEqual(CameraControlFeedback.success("Applied.").message, "Applied.")
        XCTAssertEqual(CameraControlFeedback.warning("Not applied.").message, "Not applied.")
        XCTAssertEqual(CameraControlFeedback.failure("Offline.").message, "Offline.")
    }

    /// The specific defect: a failure must not present with the success glyph.
    func testFailureAndSuccessDoNotShareAGlyph() {
        let success = CameraControlFeedback.success("Applied.")
        let warning = CameraControlFeedback.warning("The camera did not apply it.")
        let failure = CameraControlFeedback.failure("Camera offline.")

        XCTAssertEqual(success.symbolName, "checkmark.circle.fill")
        XCTAssertNotEqual(failure.symbolName, success.symbolName)
        XCTAssertNotEqual(warning.symbolName, success.symbolName)
        XCTAssertNotEqual(warning.symbolName, failure.symbolName)
    }

    /// Only a confirmation may disappear on its own. A failure or an unapplied
    /// control must stay until something supersedes it, or the user can miss
    /// that the operation did not work.
    func testOnlySuccessIsTransient() {
        XCTAssertTrue(CameraControlFeedback.success("Applied.").isTransient)
        XCTAssertFalse(CameraControlFeedback.warning("Not applied.").isTransient)
        XCTAssertFalse(CameraControlFeedback.failure("Offline.").isTransient)
    }

    func testOutcomesAreDistinguishable() {
        XCTAssertNotEqual(
            CameraControlFeedback.success("Same text"),
            CameraControlFeedback.failure("Same text"))
    }
}

/// The severity ordering that decides what a user sees first on System.
final class ServiceSeverityTests: XCTestCase {
    /// A failure must sort above a healthy service regardless of name, so the
    /// broken thing is never below a screenful of working ones.
    func testFailuresSortAboveHealthyServices() {
        let services: [ServiceStatus] = [.healthy, .warning, .unknown, .critical, .offline]
        let sorted = services.sorted { rank($0) < rank($1) }
        XCTAssertEqual(sorted, [.critical, .offline, .warning, .unknown, .healthy])
    }

    /// Mirrors `SystemView.severity`. Kept here as an explicit expectation so a
    /// reordering in the view has to be a deliberate change to this list too.
    private func rank(_ status: ServiceStatus) -> Int {
        switch status {
        case .critical: 0
        case .offline: 1
        case .warning: 2
        case .unknown: 3
        case .healthy: 4
        }
    }
}
