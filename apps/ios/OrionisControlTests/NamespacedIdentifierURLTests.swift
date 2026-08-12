import XCTest

@testable import OrionisControl

/// Every id crossing the gateway boundary is `slug:upstreamId`, so a camera on a
/// connection is `blink-lostblink:driveway` rather than `driveway`. Getting that
/// into a URL path is the whole of this file.
final class NamespacedIdentifierURLTests: XCTestCase {
    private let base = URL(string: "https://gateway.example.com")!

    /// The regression. `escaped()` encodes each interpolated id, and
    /// `URL.appending(path:)` encoded the result a second time — the colon became
    /// `%3A`, then the percent became `%25`, and the gateway received
    /// `blink-lostblink%253Adriveway`. Decoding that once yields
    /// `blink-lostblink%3Adriveway`, which has no colon to split on, so a camera
    /// that existed answered `"…" is not a valid camera identifier.`
    func testNamespacedCameraIdIsNotEncodedTwice() async throws {
        let url = try await APIClient(baseURL: base)
            .debugURL(for: Endpoint(path: "/cameras/blink-lostblink%3Adriveway"))

        XCTAssertFalse(
            url.absoluteString.contains("%25"),
            "a percent was re-encoded: \(url.absoluteString)")
        XCTAssertEqual(
            url.absoluteString,
            "https://gateway.example.com/api/mobile/v1/cameras/blink-lostblink%3Adriveway")
    }

    /// A literal colon is legal in a path segment (RFC 3986 `pchar`), so it must
    /// survive untouched rather than being "helpfully" escaped on the way out.
    func testALiteralColonSurvives() async throws {
        let url = try await APIClient(baseURL: base)
            .debugURL(for: Endpoint(path: "/cameras/blink-lostblink:driveway"))

        XCTAssertFalse(url.absoluteString.contains("%25"))
        XCTAssertTrue(url.absoluteString.hasSuffix("/cameras/blink-lostblink:driveway"))
    }

    /// Sub-resources of a namespaced camera are where this first showed up — the
    /// snapshot request 404s alongside the camera itself.
    func testSubResourcePathsKeepTheirSeparators() async throws {
        let url = try await APIClient(baseURL: base)
            .debugURL(for: Endpoint(path: "/cameras/blink-lostblink%3Adriveway/snapshot"))

        XCTAssertTrue(url.absoluteString.hasSuffix("blink-lostblink%3Adriveway/snapshot"))
        XCTAssertFalse(url.absoluteString.contains("%252F"))
    }

    /// A gateway published under a sub-path must not lose it, and must not end up
    /// with a doubled slash either.
    func testABaseURLWithAPathPrefixIsPreserved() async throws {
        let url = try await APIClient(baseURL: URL(string: "https://example.com/orionis/")!)
            .debugURL(for: Endpoint(path: "/cameras/front"))

        XCTAssertEqual(
            url.absoluteString, "https://example.com/orionis/api/mobile/v1/cameras/front")
    }

    func testQueryItemsStillAttach() async throws {
        let url = try await APIClient(baseURL: base)
            .debugURL(
                for: Endpoint(path: "/events", query: ["cameraId": "blink-lostblink%3Adriveway"]))

        XCTAssertTrue(url.absoluteString.contains("cameraId="))
        XCTAssertFalse(url.absoluteString.contains("%2525"))
    }
}
