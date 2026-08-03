import Foundation
import XCTest

@testable import OrionisControl

final class RecordingTimelineTests: XCTestCase {
    private func date(_ seconds: TimeInterval) -> Date {
        Date(timeIntervalSince1970: seconds)
    }

    func testWindowNeverStartsBeforeCoverage() throws {
        let coverage = [DateInterval(start: date(1_000), end: date(1_200))]
        let window = try XCTUnwrap(
            RecordingWindowPolicy.window(
                containing: date(1_050), coverage: coverage,
                dayEnd: date(2_000), maximumDuration: 90))

        XCTAssertEqual(window.start, date(1_000))
        XCTAssertEqual(window.durationSeconds, 90)
        XCTAssertEqual(window.playableEnd, date(1_090))
        XCTAssertEqual(window.continuation, date(1_090))
    }

    func testFractionalTailContinuesAtCoverageEndInsteadOfReloadingSameWindow() throws {
        let coverage = [DateInterval(start: date(1_000), end: date(1_089.75))]
        let window = try XCTUnwrap(
            RecordingWindowPolicy.window(
                containing: date(1_050), coverage: coverage,
                dayEnd: date(2_000), maximumDuration: 90))

        XCTAssertEqual(window.durationSeconds, 89)
        XCTAssertEqual(window.playableEnd, date(1_089))
        XCTAssertEqual(window.continuation, date(1_089.75))
    }

    func testGapAndSubsecondTailDoNotCreateInvalidClipRequests() {
        let coverage = [DateInterval(start: date(1_000), end: date(1_100))]
        XCTAssertNil(
            RecordingWindowPolicy.window(
                containing: date(1_200), coverage: coverage,
                dayEnd: date(2_000), maximumDuration: 90))

        let tiny = [DateInterval(start: date(1_000), end: date(1_000.5))]
        XCTAssertNil(
            RecordingWindowPolicy.window(
                containing: date(1_000.25), coverage: tiny,
                dayEnd: date(2_000), maximumDuration: 90))
    }

    func testWindowStopsAtTodayRatherThanRequestingFutureFootage() throws {
        let coverage = [DateInterval(start: date(1_000), end: date(1_200))]
        let window = try XCTUnwrap(
            RecordingWindowPolicy.window(
                containing: date(1_020), coverage: coverage,
                dayEnd: date(1_050.5), maximumDuration: 90))

        XCTAssertEqual(window.durationSeconds, 50)
        XCTAssertEqual(window.playableEnd, date(1_050))
    }
}
