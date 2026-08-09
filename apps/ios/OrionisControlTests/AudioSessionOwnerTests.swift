import AVFoundation
import XCTest

@testable import OrionisControl

/// The audio session is shared with the whole device, so the properties worth
/// pinning are the ones whose failure is invisible in this app and obvious in
/// someone else's: taking the audio exclusively, or never handing it back.
@MainActor
final class AudioSessionOwnerTests: XCTestCase {
    /// Records what would have been asked of the real session.
    private final class SpySession: AudioSessionConfiguring {
        var categories: [(AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)] = []
        var activations: [(Bool, AVAudioSession.SetActiveOptions)] = []
        var activationError: Error?

        func setCategory(
            _ category: AVAudioSession.Category,
            mode: AVAudioSession.Mode,
            options: AVAudioSession.CategoryOptions
        ) throws {
            if let activationError { throw activationError }
            categories.append((category, mode, options))
        }

        func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
            if let activationError, active { throw activationError }
            activations.append((active, options))
        }
    }

    private struct Failure: Error {}

    private func makeOwner() -> (AudioSessionOwner, SpySession) {
        let spy = SpySession()
        return (AudioSessionOwner(session: spy), spy)
    }

    // MARK: The rule that broke the microphone

    func testAudioIsNeverTakenExclusively() {
        // Without .mixWithOthers, activating an output-only category interrupts
        // every other session on the device — a call, a screen share, a
        // recording with the mic open — and none of them resume on their own.
        let (owner, spy) = makeOwner()
        owner.claim(self)

        XCTAssertEqual(spy.categories.count, 1)
        XCTAssertEqual(spy.categories.first?.0, .playback)
        XCTAssertEqual(spy.categories.first?.1, .moviePlayback)
        XCTAssertTrue(
            spy.categories.first?.2.contains(.mixWithOthers) == true,
            "camera audio must mix, never seize the device's audio")
    }

    func testReleasingTellsOtherAppsTheyMayResume() {
        let (owner, spy) = makeOwner()
        owner.claim(self)
        owner.relinquish(self)

        let deactivation = spy.activations.last
        XCTAssertEqual(deactivation?.0, false)
        XCTAssertTrue(
            deactivation?.1.contains(.notifyOthersOnDeactivation) == true,
            "silence in the app that ducked for us is indistinguishable from a broken device")
    }

    // MARK: Counting

    func testSecondClaimDoesNotReactivate() {
        let (owner, spy) = makeOwner()
        let other = NSObject()
        owner.claim(self)
        owner.claim(other)

        XCTAssertEqual(spy.activations.filter { $0.0 }.count, 1)
        XCTAssertEqual(spy.categories.count, 1)
    }

    func testOnePlayerCannotDeactivateAudioAnotherIsUsing() {
        // The live viewer and the recordings timeline both want audio across a
        // navigation transition; whichever leaves first must not cut the other.
        let (owner, spy) = makeOwner()
        let other = NSObject()
        owner.claim(self)
        owner.claim(other)

        owner.relinquish(self)
        XCTAssertTrue(owner.isActive)
        XCTAssertTrue(spy.activations.allSatisfy { $0.0 }, "nothing should be deactivated yet")

        owner.relinquish(other)
        XCTAssertFalse(owner.isActive)
        XCTAssertEqual(spy.activations.last?.0, false)
    }

    func testReleasingSomethingThatNeverClaimedIsHarmless() {
        let (owner, spy) = makeOwner()
        owner.claim(self)
        owner.relinquish(NSObject())

        XCTAssertTrue(owner.isActive, "an unrelated release must not drop a live claim")
        XCTAssertEqual(spy.activations.filter { !$0.0 }.count, 0)
    }

    func testDoubleReleaseDoesNotDeactivateTwice() {
        let (owner, spy) = makeOwner()
        owner.claim(self)
        owner.relinquish(self)
        owner.relinquish(self)

        XCTAssertEqual(spy.activations.filter { !$0.0 }.count, 1)
    }

    // MARK: Interruption and route changes

    func testInterruptionKeepsTheClaimSoPlaybackCanResume() {
        let (owner, spy) = makeOwner()
        owner.claim(self)

        // A call arrives: iOS deactivates the session under us.
        owner.noteSystemDeactivation()
        XCTAssertFalse(owner.isActive)

        // The interruption ends and the player claims again — the same claimant,
        // so this has to reactivate rather than early-return.
        XCTAssertTrue(owner.claim(self))
        XCTAssertTrue(owner.isActive)
        XCTAssertEqual(spy.activations.filter { $0.0 }.count, 2)
    }

    func testRouteChangeReappliesTheCategoryWhileActive() {
        // Switching to Bluetooth or AirPlay leaves the session active, so a
        // plain claim would return early and change nothing.
        let (owner, spy) = makeOwner()
        owner.claim(self)
        XCTAssertTrue(owner.reassertCategory())
        XCTAssertEqual(spy.categories.count, 2)
    }

    func testRouteChangeWithNoClaimantDoesNothing() {
        let (owner, spy) = makeOwner()
        XCTAssertFalse(owner.reassertCategory())
        XCTAssertTrue(spy.categories.isEmpty)
    }

    // MARK: Failure

    func testAFailedActivationIsReportedAndTheClaimSurvives() {
        let (owner, spy) = makeOwner()
        spy.activationError = Failure()

        XCTAssertFalse(owner.claim(self), "the caller needs to know audio is not usable")
        XCTAssertFalse(owner.isActive)

        // Dropping the claim on failure would leave the later release
        // unbalanced; a retry must still be able to succeed.
        spy.activationError = nil
        XCTAssertTrue(owner.reassertCategory())
        XCTAssertTrue(owner.isActive)
    }
}
