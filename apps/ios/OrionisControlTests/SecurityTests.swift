import XCTest

@testable import OrionisControl

final class PKCETests: XCTestCase {
    func testGeneratedVerifierMeetsRFC7636() {
        let pair = PKCEPair.generate()
        XCTAssertGreaterThanOrEqual(pair.verifier.count, 43)
        XCTAssertLessThanOrEqual(pair.verifier.count, 128)
        XCTAssertEqual(pair.method, "S256")
        XCTAssertTrue(PKCEPair.isValidVerifier(pair.verifier))
    }

    func testChallengeIsDeterministicAndDiffersFromVerifier() {
        let pair = PKCEPair.generate()
        XCTAssertEqual(PKCEPair.challenge(for: pair.verifier), pair.challenge)
        XCTAssertNotEqual(pair.challenge, pair.verifier)
    }

    func testChallengeMatchesKnownVector() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        XCTAssertEqual(
            PKCEPair.challenge(for: verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testVerifiersAreUnique() {
        let verifiers = Set((0..<200).map { _ in PKCEPair.generate().verifier })
        XCTAssertEqual(verifiers.count, 200)
    }

    func testInvalidVerifiersRejected() {
        XCTAssertFalse(PKCEPair.isValidVerifier("short"))
        XCTAssertFalse(PKCEPair.isValidVerifier(String(repeating: "a", count: 129)))
        XCTAssertFalse(PKCEPair.isValidVerifier(String(repeating: "a", count: 42) + "!"))
        XCTAssertTrue(PKCEPair.isValidVerifier(String(repeating: "a", count: 43)))
    }

    func testStateComparisonIsExact() {
        let state = OAuthState.generate()
        XCTAssertTrue(OAuthState.matches(state, state))
        XCTAssertFalse(OAuthState.matches(state, state + "x"))
        XCTAssertFalse(OAuthState.matches(state, String(state.dropLast())))
        XCTAssertFalse(OAuthState.matches("", "a"))
    }

    func testBase64URLEncodingHasNoPaddingOrUnsafeCharacters() {
        for _ in 0..<50 {
            let encoded = PKCEPair.generate().verifier
            XCTAssertFalse(encoded.contains("="))
            XCTAssertFalse(encoded.contains("+"))
            XCTAssertFalse(encoded.contains("/"))
        }
    }
}

final class KeychainStoreTests: XCTestCase {
    func testInMemoryStoreRoundTrips() throws {
        let store = InMemorySecretStore()
        try store.set("value", for: .accessToken)
        XCTAssertEqual(try store.get(.accessToken), "value")
        try store.remove(.accessToken)
        XCTAssertNil(try store.get(.accessToken))
    }

    func testRemoveAllClearsEverySecretKind() throws {
        let store = InMemorySecretStore()
        for key in SecretKey.allCases {
            try store.set("x", for: key)
        }
        try store.removeAll()
        XCTAssertTrue(store.isEmpty)
        for key in SecretKey.allCases {
            XCTAssertNil(try store.get(key), "\(key) survived removeAll")
        }
    }

    func testMissingKeyReturnsNilRatherThanThrowing() throws {
        let store = InMemorySecretStore()
        XCTAssertNil(try store.get(.refreshToken))
    }
}

private final class UnavailableSecretStore: SecretStoring, @unchecked Sendable {
    func set(_ value: String, for key: SecretKey) throws { throw KeychainError.invalidData }
    func get(_ key: SecretKey) throws -> String? { nil }
    func remove(_ key: SecretKey) throws {}
    func removeAll() throws {}
}

final class AuthenticationStorageTests: XCTestCase {
    private func configuration() -> AppConfiguration {
        AppConfiguration(
            apiBaseURL: URL(string: "https://gateway.example.com"),
            oauthClientID: "orionis-control-mobile",
            oauthRedirectScheme: "orioniscontrol",
            environment: .development,
            displayName: "Orionis Control",
            version: "0.1.9",
            build: "1")
    }

    @MainActor
    func testDeviceIdentifierRemainsStableWhenSecureStorageIsUnavailable() {
        let auth = AuthenticationService(
            configuration: configuration(),
            api: APIClient(baseURL: URL(string: "https://gateway.example.com")!),
            secrets: UnavailableSecretStore())

        XCTAssertEqual(auth.deviceId, auth.deviceId)
    }

    @MainActor
    func testSignOutPreservesPerInstallDeviceIdentifier() async throws {
        let secrets = InMemorySecretStore(seed: [
            .deviceId: "install-1",
            .accessToken: "access",
            .refreshToken: "refresh",
            .accessTokenExpiry: "9999999999",
            .sessionId: "session-1",
        ])
        let auth = AuthenticationService(
            configuration: configuration(),
            api: APIClient(baseURL: URL(string: "https://gateway.example.com")!),
            secrets: secrets)

        await auth.signOut()

        XCTAssertEqual(try secrets.get(.deviceId), "install-1")
        XCTAssertNil(try secrets.get(.accessToken))
        XCTAssertNil(try secrets.get(.refreshToken))
        XCTAssertNil(try secrets.get(.sessionId))
    }

    @MainActor
    func testTransientNetworkFailureDuringRestoreKeepsTheSession() async throws {
        // A profile cached from a previous successful session.
        let cached = CurrentUser(
            id: "u1", username: "pat", displayName: "Pat", email: nil,
            role: .administrator, groups: ["admins"], permissions: [.camerasView])
        let cachedJSON = String(data: try JSONEncoder().encode(cached), encoding: .utf8)!
        let secrets = InMemorySecretStore(seed: [
            .deviceId: "install-1",
            .accessToken: "access",
            .refreshToken: "refresh",
            .accessTokenExpiry: "9999999999",
            .cachedUser: cachedJSON,
        ])

        // Every request fails as a transient network timeout — a Wi-Fi/cellular
        // switch at launch, exactly the case that used to wipe the session.
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FailingURLProtocol.self]
        let api = APIClient(
            baseURL: URL(string: "https://gateway.example.com")!,
            session: URLSession(configuration: config))
        let auth = AuthenticationService(
            configuration: configuration(), api: api, secrets: secrets)

        await auth.restore(hasConfiguredServer: true)

        // Credentials survive the blip...
        XCTAssertEqual(try secrets.get(.refreshToken), "refresh")
        XCTAssertNotNil(try secrets.get(.cachedUser))
        // ...and the app stays signed in on the cached profile — no forced re-auth.
        XCTAssertTrue(auth.state.isSignedIn)
    }
}

/// Fails every request as a transient network timeout.
private final class FailingURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
    }
    override func stopLoading() {}
}

final class PermissionTests: XCTestCase {
    private func user(role: Role, permissions: [Permission]) -> CurrentUser {
        CurrentUser(
            id: "u1", username: "test", displayName: nil, email: nil,
            role: role, groups: [], permissions: permissions)
    }

    func testCanReflectsGrantedPermissions() {
        let viewer = user(role: .viewer, permissions: [.camerasView, .adguardView])
        XCTAssertTrue(viewer.can(.camerasView))
        XCTAssertFalse(viewer.can(.adguardProtectionPause))
        XCTAssertFalse(viewer.can(.auditView))
    }

    func testRolesAreOrdered() {
        XCTAssertLessThan(Role.viewer, Role.operatorRole)
        XCTAssertLessThan(Role.operatorRole, Role.administrator)
        XCTAssertGreaterThan(Role.administrator, Role.viewer)
    }

    func testRoleRawValuesMatchTheServerContract() {
        XCTAssertEqual(Role.viewer.rawValue, "viewer")
        XCTAssertEqual(Role.operatorRole.rawValue, "operator")
        XCTAssertEqual(Role.administrator.rawValue, "administrator")
    }

    func testControlRequestsDeclareTheRightPermissionAndDisruption() {
        XCTAssertEqual(
            CameraControlRequest(action: .ptz).requiredPermission, .camerasControlPTZ)
        XCTAssertEqual(
            CameraControlRequest(action: .restart).requiredPermission, .camerasRestart)
        XCTAssertTrue(CameraControlRequest(action: .restart).isDisruptive)
        XCTAssertTrue(CameraControlRequest(action: .siren).isDisruptive)
        XCTAssertFalse(CameraControlRequest(action: .ptz).isDisruptive)
        XCTAssertFalse(CameraControlRequest(action: .light).isDisruptive)
    }
}

final class DiagnosticsRedactionTests: XCTestCase {
    func testRemovesJWTs() {
        let jwt =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1"
        let output = DiagnosticsReport.redact("Authorization header was \(jwt)")
        XCTAssertFalse(output.contains("eyJhbGciOi"))
        XCTAssertTrue(output.contains("[token removed]"))
    }

    func testRemovesBearerTokens() {
        let output = DiagnosticsReport.redact("Bearer abc123DEF456ghi")
        XCTAssertFalse(output.contains("abc123DEF456ghi"))
    }

    func testRemovesPasswordsAndSecrets() {
        for input in [
            "password: hunter2", "client_secret=abcdef", "API_KEY: zzz", "passphrase = topsecret",
        ] {
            let output = DiagnosticsReport.redact(input)
            XCTAssertTrue(output.contains("[removed]"), "not redacted: \(input) -> \(output)")
        }
    }

    func testRemovesPrivateKeys() {
        let key = """
            -----BEGIN PRIVATE KEY-----
            MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ
            -----END PRIVATE KEY-----
            """
        XCTAssertEqual(DiagnosticsReport.redact(key), "[private key removed]")
    }

    func testRemovesIPAddressesAndEmails() {
        let output = DiagnosticsReport.redact("host 192.168.1.50 owner pat@example.com")
        XCTAssertFalse(output.contains("192.168.1.50"))
        XCTAssertFalse(output.contains("pat@example.com"))
    }

    func testRemovesCookies() {
        let output = DiagnosticsReport.redact("Cookie: session=abc123")
        XCTAssertFalse(output.contains("abc123"))
    }

    func testHostRedactionKeepsSchemeAndTLDOnly() {
        XCTAssertEqual(
            DiagnosticsReport.redactHost("https://gateway.internal.example.com"),
            "https://[host removed].com")
        XCTAssertEqual(DiagnosticsReport.redactHost(""), "[not set]")
    }

    func testOrdinaryTextSurvives() {
        let input = "Version 0.1.0 build 1, role Administrator, biometrics Face ID"
        XCTAssertEqual(DiagnosticsReport.redact(input), input)
    }
}

final class ConfigurationValidationTests: XCTestCase {
    private func config(_ environment: AppConfiguration.BuildEnvironment) -> AppConfiguration {
        AppConfiguration(
            apiBaseURL: nil,
            oauthClientID: "orionis-control-mobile",
            oauthRedirectScheme: "orioniscontrol",
            environment: environment,
            displayName: "Orionis Control",
            version: "0.1.0",
            build: "1")
    }

    func testHTTPSIsRequired() {
        let issues = config(.production).validate(url: URL(string: "http://gateway.example.com"))
        XCTAssertTrue(issues.contains(.insecureBaseURL("gateway.example.com")))
    }

    func testHTTPSPasses() {
        XCTAssertTrue(config(.production).validate(url: URL(string: "https://gateway.example.com"))
            .isEmpty)
    }

    func testReleaseBuildsRejectFixtureHosts() {
        for host in ["gateway.invalid", "gateway.test", "localhost", "gateway.local"] {
            let issues = config(.production).validate(url: URL(string: "https://\(host)"))
            XCTAssertTrue(
                issues.contains { if case .fixtureURLInRelease = $0 { return true } else { return false } },
                "\(host) should be rejected in a release build")
        }
    }

    func testDevelopmentBuildsAllowLoopbackOverHTTP() {
        let issues = config(.development)
            .validate(url: URL(string: "http://localhost:8080"), allowInsecure: true)
        XCTAssertTrue(issues.isEmpty)
    }

    func testDevelopmentBuildsStillRejectPlainHTTPToRemoteHosts() {
        let issues = config(.development)
            .validate(url: URL(string: "http://gateway.example.com"), allowInsecure: true)
        XCTAssertFalse(issues.isEmpty)
    }

    func testMissingURLIsReported() {
        XCTAssertEqual(config(.production).validate(url: nil), [.missingBaseURL])
    }

    func testFixturesAreNeverAllowedInProduction() {
        XCTAssertFalse(config(.production).allowsFixtures)
    }

    func testRedirectURIDerivesFromScheme() {
        XCTAssertEqual(config(.production).redirectURI, "orioniscontrol://auth/callback")
    }
}
