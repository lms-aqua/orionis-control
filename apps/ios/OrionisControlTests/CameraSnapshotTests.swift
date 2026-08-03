import UIKit
import XCTest

@testable import OrionisControl

@MainActor
final class CameraSnapshotTests: XCTestCase {
    func testSnapshotDecoderRejectsInvalidData() async {
        let decoded = await SnapshotImageDecoder.prepare(Data("not an image".utf8), maxPixelSize: 320)
        XCTAssertNil(decoded)
    }

    func testSnapshotDecoderDownsamplesBeforePublishingToTheUI() async throws {
        let source = UIGraphicsImageRenderer(size: CGSize(width: 2_000, height: 1_000)).image {
            UIColor.systemBlue.setFill()
            $0.fill(CGRect(x: 0, y: 0, width: 2_000, height: 1_000))
        }
        let jpeg = try XCTUnwrap(source.jpegData(compressionQuality: 0.9))
        let prepared = await SnapshotImageDecoder.prepare(jpeg, maxPixelSize: 320)
        let decoded = try XCTUnwrap(prepared)

        XCTAssertLessThanOrEqual(max(decoded.image.size.width, decoded.image.size.height), 320)
        XCTAssertGreaterThan(decoded.image.size.width, decoded.image.size.height)
    }
}
