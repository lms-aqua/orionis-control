import XCTest

@testable import OrionisControl

final class ErrorMappingTests: XCTestCase {
    private func server(_ code: APIErrorCode, recoverable: Bool = false) -> APIError {
        .server(code: code, message: "message", recoverable: recoverable, requestId: "req_1")
    }

    func testReauthenticationCodesAreIdentified() {
        for code in [
            APIErrorCode.unauthenticated, .tokenExpired, .sessionRevoked, .reauthenticationRequired,
        ] {
            XCTAssertTrue(server(code).requiresReauthentication, "\(code) should force sign-in")
        }
        XCTAssertFalse(server(.insufficientRole).requiresReauthentication)
        XCTAssertFalse(server(.cameraOffline).requiresReauthentication)
    }

    func testNotConfiguredIsDistinctFromFailure() {
        XCTAssertTrue(server(.serviceNotConfigured).isNotConfigured)
        XCTAssertFalse(server(.upstreamError).isNotConfigured)
        XCTAssertTrue(server(.capabilityUnsupported).isUnsupported)
    }

    func testRetryabilityFollowsTheServerFlag() {
        XCTAssertTrue(server(.upstreamTimeout, recoverable: true).isRetryable)
        XCTAssertFalse(server(.insufficientRole, recoverable: false).isRetryable)
        XCTAssertTrue(APIError.offline.isRetryable)
        XCTAssertTrue(APIError.timedOut.isRetryable)
        // A validation problem is never fixed by pressing the button again.
        XCTAssertFalse(APIError.decoding("bad shape").isRetryable)
        XCTAssertFalse(APIError.insecureConnection("bad cert").isRetryable)
        XCTAssertFalse(APIError.configuration("no url").isRetryable)
    }

    func testEveryErrorHasATitleAndMessage() {
        let cases: [APIError] = [
            .offline, .timedOut, .cancelled,
            .insecureConnection("x"), .decoding("y"), .configuration("z"),
            .unexpectedStatus(503, requestId: nil),
            server(.cameraOffline), server(.insufficientRole), server(.serviceNotConfigured),
        ]
        for error in cases {
            XCTAssertFalse(error.title.isEmpty)
            XCTAssertFalse(error.message.isEmpty)
            // The one phrasing that is explicitly forbidden.
            XCTAssertNotEqual(error.message, "Something went wrong.")
        }
    }

    func testTitlesAreSpecificPerCategory() {
        XCTAssertEqual(server(.insufficientRole).title, "Not permitted")
        XCTAssertEqual(server(.serviceNotConfigured).title, "Not connected")
        XCTAssertEqual(server(.cameraOffline).title, "Camera offline")
        XCTAssertEqual(server(.capabilityUnsupported).title, "Not supported")
        XCTAssertEqual(APIError.offline.title, "No connection")
    }

    func testURLErrorMappingPreservesTLSFailures() {
        XCTAssertEqual(
            APIError.from(urlError: URLError(.secureConnectionFailed)).isRetryable, false)
        if case .insecureConnection = APIError.from(urlError: URLError(.serverCertificateUntrusted)) {
        } else {
            XCTFail("Certificate failures must map to insecureConnection")
        }
        XCTAssertEqual(APIError.from(urlError: URLError(.notConnectedToInternet)), .offline)
        XCTAssertEqual(APIError.from(urlError: URLError(.timedOut)), .timedOut)
        XCTAssertEqual(APIError.from(urlError: URLError(.cancelled)), .cancelled)
    }

    func testRequestIdIsCarriedForSupport() {
        XCTAssertEqual(server(.internalError).requestId, "req_1")
    }
}

final class CameraFilteringTests: XCTestCase {
    private func camera(
        id: String, name: String, status: CameraStatus = .online, location: String? = nil
    ) -> Camera {
        Camera(
            id: id, name: name, location: location, group: nil, model: nil, firmware: nil,
            capabilities: CameraCapabilities(),
            health: CameraHealth(status: status),
            snapshotPath: nil)
    }

    private lazy var cameras: [Camera] = [
        camera(id: "a", name: "Front Door", location: "Entry"),
        camera(id: "b", name: "Back Yard", status: .offline, location: "Garden"),
        camera(id: "c", name: "Garage", location: "Entry"),
    ]

    func testSearchMatchesNameAndLocation() {
        let byName = CamerasViewModel.filter(
            cameras, search: "front", status: .all, location: nil, favouritesOnly: false,
            favourites: [])
        XCTAssertEqual(byName.map(\.id), ["a"])

        let byLocation = CamerasViewModel.filter(
            cameras, search: "garden", status: .all, location: nil, favouritesOnly: false,
            favourites: [])
        XCTAssertEqual(byLocation.map(\.id), ["b"])
    }

    func testSearchIsCaseInsensitiveAndTrimmed() {
        let result = CamerasViewModel.filter(
            cameras, search: "  GARAGE ", status: .all, location: nil, favouritesOnly: false,
            favourites: [])
        XCTAssertEqual(result.map(\.id), ["c"])
    }

    func testStatusFilter() {
        let online = CamerasViewModel.filter(
            cameras, search: "", status: .online, location: nil, favouritesOnly: false,
            favourites: [])
        XCTAssertEqual(Set(online.map(\.id)), ["a", "c"])

        let offline = CamerasViewModel.filter(
            cameras, search: "", status: .offline, location: nil, favouritesOnly: false,
            favourites: [])
        XCTAssertEqual(offline.map(\.id), ["b"])
    }

    func testLocationFilter() {
        let entry = CamerasViewModel.filter(
            cameras, search: "", status: .all, location: "Entry", favouritesOnly: false,
            favourites: [])
        XCTAssertEqual(Set(entry.map(\.id)), ["a", "c"])
    }

    func testFavouritesSortFirstThenOfflineThenName() {
        let result = CamerasViewModel.filter(
            cameras, search: "", status: .all, location: nil, favouritesOnly: false,
            favourites: ["c"])
        // Favourite first, then the offline camera, then the rest by name.
        XCTAssertEqual(result.map(\.id), ["c", "b", "a"])
    }

    func testFavouritesOnly() {
        let result = CamerasViewModel.filter(
            cameras, search: "", status: .all, location: nil, favouritesOnly: true,
            favourites: ["b"])
        XCTAssertEqual(result.map(\.id), ["b"])
    }

    func testEmptySearchReturnsEverything() {
        let result = CamerasViewModel.filter(
            cameras, search: "", status: .all, location: nil, favouritesOnly: false,
            favourites: [])
        XCTAssertEqual(result.count, 3)
    }
}

final class EventSearchTests: XCTestCase {
    private func event(id: String, camera: String, type: CameraEventType) -> CameraEvent {
        CameraEvent(
            id: id, cameraId: "cam", cameraName: camera, type: type, severity: .info,
            occurredAt: Date(), endedAt: nil, confidence: nil, thumbnailPath: nil,
            clipPath: nil, recordingId: nil, retentionUntil: nil, acknowledged: false,
            acknowledgedBy: nil, acknowledgedAt: nil, note: nil)
    }

    func testSearchMatchesCameraNameAndType() {
        let events = [
            event(id: "1", camera: "Front Door", type: .person),
            event(id: "2", camera: "Back Yard", type: .vehicle),
        ]
        XCTAssertEqual(EventsViewModel.search(events, text: "front").map(\.id), ["1"])
        XCTAssertEqual(EventsViewModel.search(events, text: "vehicle").map(\.id), ["2"])
        XCTAssertEqual(EventsViewModel.search(events, text: "").count, 2)
        XCTAssertTrue(EventsViewModel.search(events, text: "nothing").isEmpty)
    }

    func testFilterKnowsWhetherItIsActive() {
        XCTAssertFalse(EventFilter().isFiltered)
        XCTAssertTrue(EventFilter(types: [.person]).isFiltered)
        XCTAssertTrue(EventFilter(acknowledged: false).isFiltered)
    }

    func testSeverityIsOrdered() {
        XCTAssertLessThan(EventSeverity.info, EventSeverity.warning)
        XCTAssertLessThan(EventSeverity.warning, EventSeverity.critical)
    }
}

final class DeepLinkRoutingTests: XCTestCase {
    func testCameraLink() {
        XCTAssertEqual(
            DeepLinkRouter.destination(host: "camera", path: "/front-door"),
            .camera("front-door"))
    }

    func testEventLink() {
        XCTAssertEqual(
            DeepLinkRouter.destination(host: "event", path: "/evt-42"), .event("evt-42"))
    }

    func testSectionLinks() {
        XCTAssertEqual(DeepLinkRouter.destination(host: "adguard", path: ""), .adGuard)
        XCTAssertEqual(DeepLinkRouter.destination(host: "system", path: "/"), .system)
        XCTAssertEqual(DeepLinkRouter.destination(host: "settings", path: ""), .settings)
    }

    func testUnknownAndMalformedLinksAreIgnored() {
        XCTAssertNil(DeepLinkRouter.destination(host: "unknown", path: "/x"))
        XCTAssertNil(DeepLinkRouter.destination(host: "camera", path: ""))
        XCTAssertNil(DeepLinkRouter.destination(host: nil, path: "/camera/a"))
    }

    @MainActor
    func testAuthCallbackIsNotTreatedAsANavigationLink() {
        let router = DeepLinkRouter()
        let handled = router.handle(
            URL(string: "orioniscontrol://auth/callback?code=abc&state=xyz")!)
        XCTAssertNil(handled)
        XCTAssertNil(router.pendingDestination)
    }

    @MainActor
    func testForeignSchemesAreIgnored() {
        let router = DeepLinkRouter()
        XCTAssertNil(router.handle(URL(string: "https://evil.example.com/camera/a")!))
    }

    @MainActor
    func testHandlingSelectsTheMatchingTab() {
        let router = DeepLinkRouter()
        router.handle(URL(string: "orioniscontrol://camera/front")!)
        XCTAssertEqual(router.selectedTab, .cameras)
        XCTAssertEqual(router.consume(), .camera("front"))
        XCTAssertNil(router.pendingDestination)
    }
}

final class DecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            return ISO8601DateFormatter.orionisWithFractionalSeconds.date(from: raw)
                ?? ISO8601DateFormatter.orionisPlain.date(from: raw)
                ?? Date()
        }
        return try decoder.decode(type, from: Data(json.utf8))
    }

    func testCameraDecodesFromTheContractShape() throws {
        let camera = try decode(
            Camera.self,
            """
            {
              "id": "cam-1", "name": "Front Door", "location": "Entry", "group": null,
              "model": null, "firmware": null, "snapshotPath": null,
              "capabilities": {
                "ptz": true, "presets": false, "zoom": false, "light": true, "siren": false,
                "privacyMode": false, "twoWayAudio": false, "audio": true,
                "recordingToggle": true, "motionToggle": true, "sensitivity": false,
                "restart": true, "snapshot": true,
                "protocols": ["webrtc", "hls"], "qualities": ["auto", "high"]
              },
              "health": {
                "status": "online", "recording": true, "streaming": false,
                "motionDetected": false, "privacyEnabled": false,
                "lastSeenAt": "2026-07-31T12:00:00.000Z", "signalQuality": 0.9,
                "bitrateKbps": 2400, "frameRate": 20, "resolution": "1920x1080", "message": null
              }
            }
            """)

        XCTAssertEqual(camera.id, "cam-1")
        XCTAssertTrue(camera.capabilities.ptz)
        XCTAssertEqual(camera.capabilities.protocols, [.webrtc, .hls])
        XCTAssertEqual(camera.health.status, .online)
        XCTAssertTrue(camera.capabilities.hasAnyControl)
    }

    func testDatesWithAndWithoutFractionalSecondsBothParse() throws {
        struct Wrapper: Decodable { let at: Date }
        XCTAssertNotNil(try decode(Wrapper.self, #"{"at":"2026-07-31T12:00:00.123Z"}"#).at)
        XCTAssertNotNil(try decode(Wrapper.self, #"{"at":"2026-07-31T12:00:00Z"}"#).at)
    }

    func testUnknownEnumValueFailsLoudlyRatherThanSilently() {
        XCTAssertThrowsError(
            try decode(
                CameraStatus.self, #""teleporting""#
            ))
    }
}
