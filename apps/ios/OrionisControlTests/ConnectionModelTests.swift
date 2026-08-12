import XCTest

@testable import OrionisControl

/// Decoding for the connections API.
///
/// The gateway is deployed independently of the app, so these tests pin the
/// two properties that matter when the two versions disagree: a payload the app
/// half-understands must still decode, and a stored credential must never
/// appear in a decoded model — the API sends presence, not values.
final class ConnectionModelTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(type, from: Data(json.utf8))
    }

    // MARK: Provider descriptions

    func testProviderFieldDecodesEveryDeclaredKind() throws {
        let field = try decode(
            ProviderField.self,
            """
            {"key":"baseUrl","label":"Frigate URL","type":"url","required":true,
             "placeholder":"http://frigate:5000","help":"Reachable from the gateway."}
            """)
        XCTAssertEqual(field.key, "baseUrl")
        XCTAssertEqual(field.type, .url)
        XCTAssertTrue(field.required)
        XCTAssertEqual(field.id, "baseUrl")
    }

    func testUnknownFieldKindFallsBackToTextRatherThanFailing() throws {
        // A gateway newer than this build may describe a field kind that did not
        // exist when the app shipped. Rendering it as text is usable; failing the
        // whole provider list would take the screen down.
        let field = try decode(
            ProviderField.self,
            #"{"key":"colour","label":"Colour","type":"colour-picker","required":false}"#)
        XCTAssertEqual(field.type, .text)
    }

    func testFieldDefaultsSurviveAsWhicheverScalarTheyWere() throws {
        let text = try decode(
            ProviderField.self,
            #"{"key":"mode","label":"Discovery","type":"text","required":true,"default":"go2rtc"}"#)
        XCTAssertEqual(text.defaultValue?.stringValue, "go2rtc")

        let number = try decode(
            ProviderField.self,
            #"{"key":"rtspPort","label":"RTSPS port","type":"number","required":false,"default":7441}"#)
        // Rendered into a text field, so a trailing ".0" would be visible.
        XCTAssertEqual(number.defaultValue?.stringValue, "7441")

        let flag = try decode(
            ProviderField.self,
            #"{"key":"verify","label":"Verify","type":"boolean","required":false,"default":true}"#)
        XCTAssertEqual(flag.defaultValue?.boolValue, true)
    }

    func testFieldIsOrdinaryUnlessItSaysOtherwise() throws {
        // Every gateway that predates the flag describes ordinary fields, and
        // defaulting to advanced would collapse the whole form out of sight.
        let plain = try decode(
            ProviderField.self,
            #"{"key":"email","label":"Blink email","type":"text","required":true}"#)
        XCTAssertFalse(plain.advanced)

        let tucked = try decode(
            ProviderField.self,
            #"{"key":"rtspBaseUrl","label":"RTSP base URL","type":"url","required":false,"advanced":true}"#)
        XCTAssertTrue(tucked.advanced)
    }

    func testProvisionedFieldsAreHiddenRatherThanMerelyCollapsed() throws {
        // Asking for the address of a container that does not exist yet is the
        // complaint this whole flow exists to fix, so those fields come out of
        // the form entirely — not into a disclosure someone can still type in.
        let descriptor = try decode(
            ProviderDescriptor.self,
            """
            {"id":"lostblink","displayName":"Blink (lostblink)","summary":"Blink cameras.",
             "capabilities":{"snapshots":false,"liveStream":true,"events":false,
                             "eventDetection":false,"recordings":false,"controls":false,
                             "storageReporting":false,"interactiveAuth":true},
             "fields":[{"key":"email","label":"Blink email","type":"text","required":true},
                       {"key":"password","label":"Blink password","type":"secret","required":true},
                       {"key":"mediamtxApiUrl","label":"MediaMTX API URL","type":"url",
                        "required":false,"advanced":true}],
             "bridge":{"template":"lostblink","summary":"Orionis can start one.",
                       "provides":["mediamtxApiUrl","rtspBaseUrl"]}}
            """)

        XCTAssertEqual(descriptor.bridge?.template, "lostblink")
        XCTAssertEqual(descriptor.visibleFields(provisioning: false).count, 3)
        XCTAssertEqual(
            descriptor.visibleFields(provisioning: true).map(\.key), ["email", "password"])
    }

    func testAnOptionalBridgeKeepsTheFieldsItWouldSupply() throws {
        // go2rtc is a convenience, not a necessity, and the one Orionis starts
        // publishes no streams until someone points it at cameras. Hiding the
        // address there left the source reporting healthy over an empty camera
        // wall with nothing left to type into.
        let descriptor = try decode(
            ProviderDescriptor.self,
            """
            {"id":"rtsp","displayName":"RTSP / go2rtc","summary":"Any RTSP source.",
             "capabilities":{"snapshots":true,"liveStream":true,"events":false,
                             "eventDetection":false,"recordings":false,"controls":false,
                             "storageReporting":false,"interactiveAuth":false},
             "fields":[{"key":"mode","label":"Discovery","type":"text","required":true},
                       {"key":"baseUrl","label":"go2rtc URL","type":"url","required":false},
                       {"key":"streams","label":"RTSP streams","type":"text","required":false}],
             "bridge":{"template":"go2rtc","summary":"Orionis can start one.",
                       "provides":["baseUrl"],"optional":true}}
            """)

        XCTAssertEqual(descriptor.bridge?.optional, true)
        XCTAssertEqual(
            descriptor.visibleFields(provisioning: true).map(\.key),
            ["mode", "baseUrl", "streams"])
    }

    func testABridgeIsMandatoryUnlessItSaysOtherwise() throws {
        // A gateway older than the `optional` field only ever described bridges
        // the provider could not work without, so absent must keep meaning
        // "hide what it supplies".
        let descriptor = try decode(
            ProviderDescriptor.self,
            """
            {"id":"wyze","displayName":"Wyze","summary":"Wyze cameras.",
             "capabilities":{"snapshots":true,"liveStream":true,"events":false,
                             "eventDetection":false,"recordings":false,"controls":false,
                             "storageReporting":false,"interactiveAuth":false},
             "fields":[{"key":"baseUrl","label":"Bridge URL","type":"url","required":false}],
             "bridge":{"template":"wyze","summary":"Orionis can start one.",
                       "provides":["baseUrl"]}}
            """)

        XCTAssertEqual(descriptor.bridge?.optional, false)
        XCTAssertTrue(descriptor.visibleFields(provisioning: true).isEmpty)
    }

    func testProviderWithoutABridgeDecodesAndHidesNothing() throws {
        let descriptor = try decode(
            ProviderDescriptor.self,
            """
            {"id":"frigate","displayName":"Frigate","summary":"Frigate NVR.",
             "capabilities":{"snapshots":true,"liveStream":true,"events":true,
                             "eventDetection":true,"recordings":true,"controls":false,
                             "storageReporting":true,"interactiveAuth":false},
             "fields":[{"key":"baseUrl","label":"Frigate URL","type":"url","required":true}]}
            """)
        XCTAssertNil(descriptor.bridge)
        XCTAssertEqual(descriptor.visibleFields(provisioning: true).count, 1)
    }

    // MARK: Bridge provisioning

    func testProvisioningStatesSayWhetherToKeepWatching() throws {
        let building = try decode(
            ConnectionProvisioning.self,
            """
            {"connectionId":"conn_1","requestId":"prov_1","template":"lostblink",
             "instance":"blink-front","state":"provisioning","message":"Starting the bridge…",
             "requestedAt":"2026-08-07T19:00:00Z","updatedAt":"2026-08-07T19:00:04Z"}
            """)
        XCTAssertTrue(building.isInFlight)
        XCTAssertEqual(building.title, "Setting up…")

        let failed = try decode(
            ConnectionProvisioning.self,
            """
            {"connectionId":"conn_1","requestId":"prov_1","template":"lostblink",
             "instance":"blink-front","state":"failed",
             "message":"orionis-blink-front-lostblink stopped (exit 1). two-factor authentication required.",
             "requestedAt":"2026-08-07T19:00:00Z","updatedAt":"2026-08-07T19:00:12Z"}
            """)
        XCTAssertFalse(failed.isInFlight)
        // Verbatim, because that last line is usually the whole diagnosis.
        XCTAssertTrue(failed.message?.contains("two-factor") == true)
    }

    func testUnknownProvisioningStateReadsAsStillWorking() throws {
        // A newer gateway may report a state this build has never heard of.
        // Treating it as settled would stop the app polling and strand the
        // screen on whatever it last showed.
        let unknown = try decode(
            ConnectionProvisioning.self,
            #"{"connectionId":"c","requestId":"p","template":"wyze","instance":"w","state":"reticulating"}"#)
        XCTAssertTrue(unknown.isInFlight)
    }

    func testCapabilitySummaryListsOnlyWhatTheSourceProvides() throws {
        let liveOnly = try decode(
            ProviderCapabilities.self,
            """
            {"snapshots":false,"liveStream":true,"events":false,"eventDetection":false,
             "recordings":false,"controls":false,"storageReporting":false,"interactiveAuth":false}
            """)
        XCTAssertEqual(liveOnly.summaryLine, "Live view")

        let full = try decode(
            ProviderCapabilities.self,
            """
            {"snapshots":true,"liveStream":true,"events":true,"eventDetection":true,
             "recordings":true,"controls":false,"storageReporting":true,"interactiveAuth":false}
            """)
        XCTAssertEqual(full.summaryLine, "Live view · Snapshots · Events · Recordings")
    }

    // MARK: Stored connections

    func testConnectionDecodesPresenceOfCredentialsButNeverAValue() throws {
        let connection = try decode(
            ConnectionSummary.self,
            """
            {"id":"conn_1","provider":"frigate","name":"Frigate Main","slug":"frigate-main",
             "enabled":true,"settings":{"baseUrl":"http://frigate:5000"},
             "secretsSet":{"apiKey":true},"sortOrder":100,
             "createdAt":"2026-08-06T10:00:00Z","updatedAt":"2026-08-06T10:00:00Z",
             "health":{"status":"healthy","message":"Connected.","cameraCount":4,
                       "latencyMs":12,"checkedAt":"2026-08-06T10:00:05Z"}}
            """)
        XCTAssertEqual(connection.slug, "frigate-main")
        XCTAssertTrue(connection.hasSecret("apiKey"))
        XCTAssertFalse(connection.hasSecret("clientSecret"))
        XCTAssertEqual(connection.settings["baseUrl"]?.stringValue, "http://frigate:5000")
        XCTAssertEqual(connection.health?.cameraCount, 4)
    }

    func testConnectionWithoutHealthIsNotAnError() throws {
        // A source added but never probed has no health row; that is "not
        // checked yet", not a decoding failure.
        let connection = try decode(
            ConnectionSummary.self,
            """
            {"id":"conn_2","provider":"rtsp","name":"Front Door","slug":"front-door",
             "enabled":false,"settings":{},"secretsSet":{},"sortOrder":100,
             "createdAt":null,"updatedAt":null,"health":null}
            """)
        XCTAssertNil(connection.health)
        XCTAssertFalse(connection.enabled)
    }

    func testUnknownHealthStatusDecodesAsUnknown() throws {
        let health = try decode(
            ConnectionHealth.self,
            #"{"status":"on-fire","message":null,"cameraCount":null,"latencyMs":null,"checkedAt":"2026-08-06T10:00:00Z"}"#)
        XCTAssertEqual(health.status, .unknown)
    }

    // MARK: Interactive sign-in

    func testAuthResultDecodesEachOutcome() throws {
        let complete = try decode(
            ConnectionAuthResult.self, #"{"status":"complete","message":"Signed in."}"#)
        XCTAssertEqual(complete, .complete(message: "Signed in."))

        let failed = try decode(
            ConnectionAuthResult.self, #"{"status":"failed","message":"That code was not accepted."}"#)
        XCTAssertEqual(failed, .failed(message: "That code was not accepted."))

        let challenged = try decode(
            ConnectionAuthResult.self,
            """
            {"status":"challenge","challenge":{"challengeId":"1:2","kind":"emailed_code",
             "prompt":"A code was sent.","sentTo":"p•••@example.invalid",
             "expiresAt":"2026-08-06T10:10:00Z"}}
            """)
        guard case .challenge(let challenge) = challenged else {
            return XCTFail("expected a challenge")
        }
        XCTAssertEqual(challenge.challengeId, "1:2")
        XCTAssertEqual(challenge.kind, .emailedCode)
        // Redacted at the source; the app must never see a full address.
        XCTAssertEqual(challenge.sentTo, "p•••@example.invalid")
    }

    func testUnknownAuthStatusIsTreatedAsFailureRatherThanSuccess() throws {
        // Failing closed matters here: reading an unrecognised status as
        // "complete" would tell someone they are signed in when they are not.
        let result = try decode(
            ConnectionAuthResult.self, #"{"status":"something-new","message":"?"}"#)
        XCTAssertEqual(result, .failed(message: "?"))
    }

    // MARK: Encoding

    func testCreateRequestEncodesSettingsAsTheirOwnScalarTypes() throws {
        let request = ConnectionCreateRequest(
            provider: "unifi",
            name: "Protect",
            settings: ["baseUrl": .string("https://unifi.local"), "rtspPort": .number(7441)],
            secrets: ["apiKey": "typed-just-now"],
            enabled: true)
        let json = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)

        // A port must not arrive as "7441" — the gateway validates it as a number.
        XCTAssertTrue(json.contains("\"rtspPort\":7441"))
        XCTAssertTrue(json.contains("\"baseUrl\":\"https:\\/\\/unifi.local\""))
    }

    func testUpdateRequestOmitsWhatWasNotEdited() throws {
        // Only what is present is changed server-side, so an update that touches
        // the name must not carry a nil settings or secrets key with it.
        let request = ConnectionUpdateRequest(name: "Renamed")
        let json = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
        XCTAssertTrue(json.contains("\"name\":\"Renamed\""))
        XCTAssertFalse(json.contains("secrets"))
        XCTAssertFalse(json.contains("settings"))
    }
}
