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
        XCTAssertTrue(APIError.unreachable.isRetryable)
        // A validation problem is never fixed by pressing the button again.
        XCTAssertFalse(APIError.decoding("bad shape").isRetryable)
        XCTAssertFalse(APIError.insecureConnection("bad cert").isRetryable)
        XCTAssertFalse(APIError.configuration("no url").isRetryable)
    }

    func testEveryErrorHasATitleAndMessage() {
        let cases: [APIError] = [
            .offline, .timedOut, .unreachable, .cancelled,
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
        XCTAssertEqual(APIError.from(urlError: URLError(.cannotFindHost)), .unreachable)
        XCTAssertEqual(APIError.from(urlError: URLError(.cannotConnectToHost)), .unreachable)
        XCTAssertEqual(APIError.from(urlError: URLError(.dnsLookupFailed)), .unreachable)
        XCTAssertEqual(APIError.from(urlError: URLError(.cancelled)), .cancelled)
    }

    func testRequestIdIsCarriedForSupport() {
        XCTAssertEqual(server(.internalError).requestId, "req_1")
    }
}

@MainActor
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

@MainActor
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

@MainActor
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

    // MARK: Five-tab navigation

    /// The guard rail for the whole navigation refactor: a compact-width
    /// `TabView` with six or more tabs makes UIKit generate its own "More"
    /// list, which this app must never show.
    func testPrimaryTabsNeverExceedFive() {
        XCTAssertLessThanOrEqual(RootTab.allCases.count, 5)
    }

    func testEventsAndSettingsAreNotPrimaryTabs() {
        let ids = RootTab.allCases.map(\.rawValue)
        XCTAssertFalse(ids.contains("events"))
        XCTAssertFalse(ids.contains("settings"))
        XCTAssertTrue(ids.contains("more"))
    }

    @MainActor
    func testSettingsDeepLinkOpensTheMoreHub() {
        let router = DeepLinkRouter()
        router.handle(URL(string: "orioniscontrol://settings")!)
        XCTAssertEqual(router.selectedTab, .more)
        XCTAssertEqual(router.morePath, [.settings])
        XCTAssertEqual(router.consume(), .settings)
    }

    @MainActor
    func testEventDeepLinkOpensEventsUnderMore() {
        let router = DeepLinkRouter()
        router.handle(URL(string: "orioniscontrol://event/evt-1")!)
        XCTAssertEqual(router.selectedTab, .more)
        XCTAssertEqual(router.morePath, [.events])
        XCTAssertEqual(router.consume(), .event("evt-1"))
    }

    // MARK: Cold-start delivery

    /// The cold-start contract.
    ///
    /// On a terminated-app notification tap the URL is handled while auth is
    /// still restoring, so the owning view does not exist yet. The destination
    /// must therefore survive an arbitrary delay and any number of reads, and
    /// disappear only when a view explicitly consumes it. A router that cleared
    /// it on a timer, or on the next tab change, would drop the event.
    @MainActor
    func testPendingDestinationSurvivesUntilTheOwningViewConsumesIt() {
        let router = DeepLinkRouter()
        router.handle(URL(string: "orioniscontrol://event/evt-cold")!)

        // Stand-in for the interval where RootView is showing the loading state
        // and EventsView has not been created: the value must still be there.
        XCTAssertEqual(router.pendingDestination, .event("evt-cold"))
        XCTAssertEqual(router.pendingDestination, .event("evt-cold"))
        XCTAssertEqual(router.selectedTab, .more)
        XCTAssertEqual(router.morePath, [.events])

        // EventsView finally mounts and claims it.
        XCTAssertEqual(router.consume(), .event("evt-cold"))
        XCTAssertNil(router.pendingDestination)
    }

    /// A second consumer must not receive the same destination, so a mount that
    /// races an `onChange` cannot present the event twice.
    @MainActor
    func testADestinationIsDeliveredOnlyOnce() {
        let router = DeepLinkRouter()
        router.handle(URL(string: "orioniscontrol://camera/front")!)
        XCTAssertEqual(router.consume(), .camera("front"))
        XCTAssertNil(router.consume())
    }

    // MARK: More routes

    func testEveryMoreRouteHasATitleAndSymbol() {
        let routes: [MoreRoute] = [
            .events, .settings, .account, .diagnostics, .about, .infrastructure,
        ]
        for route in routes {
            XCTAssertFalse(route.title.isEmpty, "\(route) has no title")
            XCTAssertFalse(route.symbolName.isEmpty, "\(route) has no symbol")
        }
    }

    @MainActor
    func testOperationalDeepLinksClearAStaleMorePath() {
        let router = DeepLinkRouter()
        // Leaving More by deep link must not strand the previous More route,
        // which the iPad sidebar would otherwise read back as its selection.
        router.handle(URL(string: "orioniscontrol://settings")!)
        XCTAssertEqual(router.morePath, [.settings])

        router.handle(URL(string: "orioniscontrol://adguard")!)
        XCTAssertEqual(router.selectedTab, .adGuard)
        XCTAssertTrue(router.morePath.isEmpty)

        router.handle(URL(string: "orioniscontrol://system")!)
        XCTAssertEqual(router.selectedTab, .system)
        XCTAssertTrue(router.morePath.isEmpty)
    }
}

final class DnsQueryInsightsTests: XCTestCase {
    private func query(
        _ id: String,
        domain: String,
        client: String = "192.0.2.1",
        clientName: String? = nil,
        status: QueryStatus,
        processingMs: Double? = nil
    ) -> DnsQuery {
        DnsQuery(
            id: id,
            at: Date(timeIntervalSince1970: 0),
            client: client,
            clientName: clientName,
            domain: domain,
            type: "A",
            upstream: nil,
            processingMs: processingMs,
            status: status,
            rule: nil,
            ruleFilterId: nil,
            responseCode: "NOERROR",
            reason: nil,
            answers: [])
    }

    func testInsightsDescribeOnlyTheLoadedSample() throws {
        let insights = DnsQueryInsights(queries: [
            query("1", domain: "b.example", clientName: "phone", status: .blocked, processingMs: 8),
            query("2", domain: "a.example", clientName: "phone", status: .allowed, processingMs: 2),
            query("3", domain: "b.example", clientName: "laptop", status: .blocked, processingMs: 5),
            query("4", domain: "rewrite.example", status: .rewritten),
        ])

        XCTAssertEqual(insights.total, 4)
        XCTAssertEqual(insights.allowed, 1)
        XCTAssertEqual(insights.blocked, 2)
        XCTAssertEqual(insights.other, 1)
        XCTAssertEqual(try XCTUnwrap(insights.blockRate), 200.0 / 3.0, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(insights.averageProcessingMs), 5, accuracy: 0.001)
        XCTAssertEqual(insights.slowestDomain, "b.example")
        XCTAssertEqual(insights.topDomains.first, NameCount(name: "b.example", count: 2))
        XCTAssertEqual(insights.topClients.first, NameCount(name: "phone", count: 2))
        XCTAssertTrue(insights.shareText.contains("latest 4 loaded results"))
    }

    func testInsightsIgnoreMissingAndInvalidTimings() {
        let insights = DnsQueryInsights(queries: [
            query("1", domain: "unknown.example", status: .unknown, processingMs: -Double.infinity),
            query("2", domain: "safe.example", status: .safeSearch, processingMs: nil),
        ])

        XCTAssertNil(insights.blockRate)
        XCTAssertNil(insights.averageProcessingMs)
        XCTAssertNil(insights.slowestDomain)
    }

    func testWatchedDomainsNormalizeDeduplicateToggleAndRoundTrip() {
        let decoded = WatchedDomainStore.decode(#"["Example.COM.","example.com"," second.example "]"#)
        XCTAssertEqual(decoded, ["example.com", "second.example"])
        XCTAssertTrue(WatchedDomainStore.contains("EXAMPLE.com.", in: decoded))

        let removed = WatchedDomainStore.toggling("example.com", in: decoded)
        XCTAssertEqual(removed, ["second.example"])
        let added = WatchedDomainStore.toggling("New.Example.", in: removed)
        XCTAssertEqual(added, ["new.example", "second.example"])
        XCTAssertEqual(WatchedDomainStore.decode(WatchedDomainStore.encode(added)), added)
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

    func testDeviceSessionDecodesCurrentAndRevokedState() throws {
        let session = try decode(
            SessionSummary.self,
            """
            {
              "id": "session-1", "deviceId": "device-1", "deviceName": "My iPhone",
              "createdAt": "2026-07-31T12:00:00Z", "lastUsedAt": null, "expiresAt": null,
              "revoked": false, "current": true
            }
            """)

        XCTAssertEqual(session.id, "session-1")
        XCTAssertEqual(session.deviceName, "My iPhone")
        XCTAssertFalse(session.revoked)
        XCTAssertTrue(session.current)
    }

    func testDeviceSessionDefaultsFlagsForOlderGateways() throws {
        let session = try decode(
            SessionSummary.self,
            #"{"id":"session-1","deviceId":"device-1","deviceName":null,"createdAt":null,"lastUsedAt":null,"expiresAt":null}"#)

        XCTAssertFalse(session.revoked)
        XCTAssertFalse(session.current)
    }

    func testDnsQueryPreservesTheExactAdGuardReason() throws {
        let query = try decode(
            DnsQuery.self,
            """
            {
              "id": "query-1", "at": "2026-08-03T12:00:00Z",
              "client": "192.0.2.1", "clientName": "phone",
              "domain": "example.com", "type": "A", "upstream": null,
              "processingMs": 1.5, "status": "allowed", "rule": null,
              "ruleFilterId": null, "responseCode": "NOERROR",
              "reason": "NotFilteredNotFound", "answers": ["192.0.2.2"]
            }
            """)

        XCTAssertEqual(query.status, .allowed)
        XCTAssertEqual(query.reason, "NotFilteredNotFound")
    }

    func testPageMetadataKeepsCursorOptionalForOlderGateways() throws {
        let legacy = try decode(
            PageMeta.self,
            #"{"total":null,"limit":100,"offset":0,"hasMore":false}"#)
        let cursor = try decode(
            PageMeta.self,
            #"{"total":null,"limit":100,"offset":0,"hasMore":true,"nextCursor":"cursor-1"}"#)

        XCTAssertNil(legacy.nextCursor)
        XCTAssertEqual(cursor.nextCursor, "cursor-1")
    }

    func testUnknownEnumValueFailsLoudlyRatherThanSilently() {
        XCTAssertThrowsError(
            try decode(
                CameraStatus.self, #""teleporting""#
            ))
    }
}

final class StorageStatusTests: XCTestCase {
    private func status(quotaRatio: Double?, recordings: Double? = 50, quota: Double? = 100)
        -> StorageStatus
    {
        StorageStatus(
            totalBytes: 1_000,
            usedBytes: 500,
            freeBytes: 500,
            recordingsBytes: recordings,
            quotaBytes: quota,
            quotaUsedRatio: quotaRatio,
            quotaFreeBytes: 50,
            fileCount: 1,
            dailyBytes: 10,
            daysRemaining: 5,
            retentionDays: 7,
            oldestRecordingAt: nil,
            newestRecordingAt: nil,
            perCamera: nil)
    }

    func testStorageProgressNeverEscapesZeroToOne() {
        XCTAssertEqual(status(quotaRatio: 1.5).usedFraction, 1)
        XCTAssertEqual(status(quotaRatio: -0.5).usedFraction, 0)
        XCTAssertEqual(status(quotaRatio: nil, recordings: 250).usedFraction, 1)
    }
}
