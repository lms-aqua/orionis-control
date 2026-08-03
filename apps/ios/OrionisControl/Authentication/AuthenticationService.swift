import AuthenticationServices
import Foundation
import UIKit
import os

/// The signed-in state machine the whole app observes.
enum AuthenticationState: Equatable, Sendable {
    /// Before the keychain has been consulted.
    case initialising
    /// No gateway configured yet — first launch.
    case needsServer
    /// Gateway known, nobody signed in.
    case signedOut(reason: SignedOutReason?)
    /// Browser session in flight.
    case authenticating
    /// Signed in and usable.
    case signedIn(CurrentUser)
    /// Signed in but the app is locked behind biometrics.
    case locked(CurrentUser)

    var user: CurrentUser? {
        switch self {
        case .signedIn(let user), .locked(let user): user
        default: nil
        }
    }

    var isSignedIn: Bool { user != nil }
}

enum SignedOutReason: Equatable, Sendable {
    case userInitiated
    case sessionExpired
    case sessionRevoked
    case notAuthorised
    case accountLocked
    case cancelled
    case failed(String)

    var message: String? {
        switch self {
        case .userInitiated, .cancelled: nil
        case .sessionExpired: "Your session expired. Sign in again to continue."
        case .sessionRevoked: "This session was revoked. Sign in again to continue."
        case .notAuthorised:
            "Your account signed in successfully, but it is not a member of any group permitted to use Orionis Control. Ask an administrator to grant access."
        case .accountLocked:
            "This account is locked. Contact an administrator."
        case .failed(let detail): detail
        }
    }
}

/// Tokens as held by the app. Never logged, never rendered, never exported.
struct TokenSet: Sendable, Equatable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date

    /// Refresh slightly early so a request never races the expiry.
    var needsRefresh: Bool { Date().addingTimeInterval(30) >= expiresAt }
}

// MARK: - Service

/// Owns sign-in, token lifetime and sign-out.
///
/// Design notes:
/// - The app never sees Authelia credentials or Authelia tokens. It drives
///   `ASWebAuthenticationSession` against the gateway, which brokers OIDC.
/// - The verifier is generated per attempt, persisted only for the duration of
///   the browser session, and destroyed on completion or failure.
/// - Refresh is serialised: concurrent 401s produce one refresh, not many.
@MainActor
@Observable
final class AuthenticationService: NSObject {
    private(set) var state: AuthenticationState = .initialising
    private(set) var lastError: APIError?

    private let secrets: SecretStoring
    private let configuration: AppConfiguration
    private let api: APIClient
    private let logger = Logger(
        subsystem: "com.lostmediastudios.orioniscontrol", category: "auth")

    /// Guarantees a single in-flight refresh.
    private var refreshTask: Task<String, Error>?
    private var webSession: ASWebAuthenticationSession?
    private var cachedDeviceId: String?

    init(configuration: AppConfiguration, api: APIClient, secrets: SecretStoring) {
        self.configuration = configuration
        self.api = api
        self.secrets = secrets
        super.init()
    }

    /// A stable per-install identifier. Not a device fingerprint: it is random,
    /// app-scoped, and destroyed when the app data is cleared.
    var deviceId: String {
        if let cachedDeviceId { return cachedDeviceId }
        if let existing = try? secrets.get(.deviceId), !existing.isEmpty {
            cachedDeviceId = existing
            return existing
        }
        let generated = UUID().uuidString.lowercased()
        // Keep the identifier stable for this process even if Keychain is
        // temporarily unavailable. A second read must not mint a new device.
        cachedDeviceId = generated
        try? secrets.set(generated, for: .deviceId)
        return generated
    }

    // MARK: - Restore

    /// Called at launch. Decides between setup, sign-in and the dashboard.
    func restore(hasConfiguredServer: Bool) async {
        guard hasConfiguredServer else {
            state = .needsServer
            return
        }

        guard let refresh = try? secrets.get(.refreshToken), !refresh.isEmpty else {
            state = .signedOut(reason: nil)
            return
        }

        do {
            _ = try await performRefresh(using: refresh)
            let user = try await loadCurrentUser()
            state = .signedIn(user)
        } catch let error as APIError {
            logger.notice("session restore failed: \(String(describing: error.title), privacy: .public)")
            clearSessionSecrets()
            state = .signedOut(reason: reason(for: error))
        } catch {
            state = .signedOut(reason: .failed("The saved session could not be restored."))
        }
    }

    // MARK: - Sign in

    /// Drives the full flow: PKCE → ASWebAuthenticationSession → code → tokens.
    func signIn() async {
        guard case .signedIn = state else { return await beginSignIn() }
    }

    func beginSignIn() async {
        state = .authenticating
        lastError = nil

        let pkce = PKCEPair.generate()
        let oauthState = OAuthState.generate()

        do {
            try secrets.set(pkce.verifier, for: .pendingVerifier)
            try secrets.set(oauthState, for: .pendingState)
        } catch {
            state = .signedOut(reason: .failed("Secure storage is unavailable on this device."))
            return
        }

        let base = await api.currentBaseURL
        guard
            var components = URLComponents(
                url: base.appending(path: "api/mobile/v1/auth/login"),
                resolvingAgainstBaseURL: false)
        else {
            state = .signedOut(reason: .failed("The gateway address is not usable."))
            return
        }

        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: pkce.method),
            URLQueryItem(name: "state", value: oauthState),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI),
            URLQueryItem(name: "device_id", value: deviceId),
        ]

        guard let authURL = components.url else {
            state = .signedOut(reason: .failed("The sign-in URL could not be built."))
            return
        }

        do {
            let callback = try await presentWebSession(url: authURL)
            try await completeSignIn(callback: callback, expectedState: oauthState, pkce: pkce)
        } catch let error as SignInFailure {
            clearPending()
            state = .signedOut(reason: error.reason)
        } catch let error as APIError {
            clearPending()
            lastError = error
            state = .signedOut(reason: reason(for: error))
        } catch {
            clearPending()
            state = .signedOut(reason: .failed("Sign-in could not be completed."))
        }
    }

    private enum SignInFailure: Error {
        case cancelled
        case notAuthorised
        case accountLocked
        case stateMismatch
        case providerError(String)

        var reason: SignedOutReason {
            switch self {
            case .cancelled: .cancelled
            case .notAuthorised: .notAuthorised
            case .accountLocked: .accountLocked
            case .stateMismatch:
                .failed(
                    "The sign-in response did not match this request and was discarded. Try again.")
            case .providerError(let detail): .failed(detail)
            }
        }
    }

    private func presentWebSession(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: configuration.oauthRedirectScheme
            ) { callbackURL, error in
                if let error {
                    let nsError = error as NSError
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                        nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue
                    {
                        continuation.resume(throwing: SignInFailure.cancelled)
                    } else {
                        continuation.resume(
                            throwing: SignInFailure.providerError(
                                "The sign-in window closed unexpectedly."))
                    }
                    return
                }
                guard let callbackURL else {
                    continuation.resume(
                        throwing: SignInFailure.providerError("No sign-in response was returned."))
                    return
                }
                continuation.resume(returning: callbackURL)
            }

            session.presentationContextProvider = self
            // A fresh session every time: the app must never silently reuse a
            // browser identity, and MFA policy is the identity provider's call.
            session.prefersEphemeralWebBrowserSession = false
            webSession = session

            if !session.start() {
                continuation.resume(
                    throwing: SignInFailure.providerError("The sign-in window could not be opened."))
            }
        }
    }

    private func completeSignIn(callback: URL, expectedState: String, pkce: PKCEPair) async throws {
        defer { clearPending() }

        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false) else {
            throw SignInFailure.providerError("The sign-in response could not be read.")
        }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value
        }

        // Validate state before anything else, and in constant time.
        guard let returnedState = value("state"),
            OAuthState.matches(returnedState, expectedState)
        else {
            throw SignInFailure.stateMismatch
        }

        if let errorCode = value("error") {
            switch errorCode {
            case "NOT_AUTHORIZED": throw SignInFailure.notAuthorised
            case "ACCESS_DENIED": throw SignInFailure.cancelled
            case "ACCOUNT_LOCKED": throw SignInFailure.accountLocked
            default:
                throw SignInFailure.providerError(
                    "The identity provider did not complete sign-in. Try again.")
            }
        }

        guard let code = value("code") else {
            throw SignInFailure.providerError("The sign-in response contained no authorization code.")
        }

        struct TokenRequest: Encodable {
            let code: String
            let code_verifier: String
            let device: TokenRequestDevice
        }

        struct TokenResponse: Decodable, Sendable {
            let accessToken: String
            let refreshToken: String
            let expiresIn: Int
            let user: CurrentUser
            struct SessionRef: Decodable, Sendable { let id: String }
            let session: SessionRef
        }

        let device = currentDevice()
        // Public call: the app has no session yet — this is the exchange that
        // creates one. Using the authenticated variant would try to attach a
        // Bearer token that does not exist and fail before sending.
        let response = try await api.requestPublic(
            Endpoint(
                method: .post,
                path: "/auth/token",
                body: TokenRequest(
                    code: code,
                    code_verifier: pkce.verifier,
                    device: device
                )
            ),
            as: TokenResponse.self
        )

        try store(
            TokenSet(
                accessToken: response.accessToken,
                refreshToken: response.refreshToken,
                expiresAt: Date().addingTimeInterval(TimeInterval(response.expiresIn))
            ),
            sessionId: response.session.id
        )

        state = .signedIn(response.user)
    }

    private func currentDevice() -> TokenRequestDevice {
        let device = UIDevice.current
        return TokenRequestDevice(
            deviceId: deviceId,
            deviceName: device.name,
            deviceModel: device.model,
            osVersion: "\(device.systemName) \(device.systemVersion)",
            appVersion: "\(configuration.version) (\(configuration.build))"
        )
    }

    // MARK: - Sign out

    func signOut(reason: SignedOutReason = .userInitiated) async {
        // Best effort: a failed network call must never trap the user in a
        // signed-in state locally.
        if state.isSignedIn {
            try? await api.requestVoid(Endpoint(method: .post, path: "/auth/logout"))
        }
        clearSessionSecrets()
        refreshTask?.cancel()
        refreshTask = nil
        state = .signedOut(reason: reason)
    }

    // MARK: - Locking

    func lock() {
        guard let user = state.user else { return }
        state = .locked(user)
    }

    func unlock() {
        guard case .locked(let user) = state else { return }
        state = .signedIn(user)
    }

    // MARK: - Tokens

    private func store(_ tokens: TokenSet, sessionId: String?) throws {
        do {
            // Access token last: readers never observe a new access token paired
            // with an old refresh token if secure storage fails midway.
            try secrets.set(tokens.refreshToken, for: .refreshToken)
            try secrets.set(String(tokens.expiresAt.timeIntervalSince1970), for: .accessTokenExpiry)
            if let sessionId { try secrets.set(sessionId, for: .sessionId) }
            try secrets.set(tokens.accessToken, for: .accessToken)
        } catch {
            clearSessionSecrets()
            throw error
        }
    }

    /// Clears account/session material while preserving the random per-install
    /// device identifier. Signing out is not the same as deleting the app.
    private func clearSessionSecrets() {
        for key in SecretKey.allCases where key != .deviceId {
            try? secrets.remove(key)
        }
    }

    private func currentTokens() -> TokenSet? {
        guard
            let access = try? secrets.get(.accessToken),
            let refresh = try? secrets.get(.refreshToken),
            let expiryRaw = try? secrets.get(.accessTokenExpiry),
            let expiry = TimeInterval(expiryRaw)
        else { return nil }
        return TokenSet(
            accessToken: access, refreshToken: refresh,
            expiresAt: Date(timeIntervalSince1970: expiry))
    }

    private func performRefresh(using refreshToken: String) async throws -> String {
        struct RefreshRequest: Encodable {
            let refresh_token: String
            let device: Device
            struct Device: Encodable {
                let deviceId: String
                let appVersion: String
            }
        }
        struct RefreshResponse: Decodable, Sendable {
            let accessToken: String
            let refreshToken: String
            let expiresIn: Int
        }

        // Public call: refresh authenticates via the refresh token in the body,
        // not a Bearer. The authenticated variant would recurse back into
        // validAccessToken() → refresh and dead-lock.
        let response = try await api.requestPublic(
            Endpoint(
                method: .post,
                path: "/auth/refresh",
                body: RefreshRequest(
                    refresh_token: refreshToken,
                    device: .init(
                        deviceId: deviceId,
                        appVersion: "\(configuration.version) (\(configuration.build))")
                )
            ),
            as: RefreshResponse.self
        )

        try store(
            TokenSet(
                accessToken: response.accessToken,
                refreshToken: response.refreshToken,
                expiresAt: Date().addingTimeInterval(TimeInterval(response.expiresIn))
            ),
            sessionId: nil
        )
        return response.accessToken
    }

    private func loadCurrentUser() async throws -> CurrentUser {
        struct MeResponse: Decodable, Sendable {
            let user: CurrentUser
            let session: SessionSummary
        }
        return try await api.request(Endpoint(path: "/me"), as: MeResponse.self).user
    }

    private func clearPending() {
        try? secrets.remove(.pendingVerifier)
        try? secrets.remove(.pendingState)
        webSession = nil
    }

    private func reason(for error: APIError) -> SignedOutReason {
        guard case .server(let code, _, _, _) = error else {
            return .failed(error.message)
        }
        switch code {
        case .sessionRevoked: return .sessionRevoked
        case .tokenExpired, .reauthenticationRequired: return .sessionExpired
        case .accountLocked: return .accountLocked
        case .insufficientRole, .forbidden: return .notAuthorised
        default: return .failed(error.message)
        }
    }
}

struct TokenRequestDevice: Encodable, Sendable {
    let deviceId: String
    let deviceName: String
    let deviceModel: String
    let osVersion: String
    let appVersion: String
}

// MARK: - TokenProviding

extension AuthenticationService: TokenProviding {
    nonisolated func validAccessToken() async throws -> String {
        let tokens = await MainActor.run { self.currentTokens() }

        guard let tokens else {
            throw APIError.server(
                code: .unauthenticated,
                message: "There is no signed-in session on this device.",
                recoverable: false,
                requestId: nil)
        }

        // Refresh proactively rather than letting the request 401 first.
        guard tokens.needsRefresh else { return tokens.accessToken }
        return try await refreshAccessToken()
    }

    nonisolated func refreshAccessToken() async throws -> String {
        try await MainActor.run { self.startRefreshIfNeeded() }.value
    }

    nonisolated func handleAuthenticationFailure(_ error: APIError) async {
        let reason = await MainActor.run {
            self.lastError = error
            return self.reason(for: error)
        }
        // Do not return while stale credentials are still usable by callers.
        await self.signOut(reason: reason)
    }

    /// Coalesces concurrent refreshes into one network call.
    private func startRefreshIfNeeded() -> Task<String, Error> {
        if let existing = refreshTask { return existing }

        let task = Task<String, Error> { [weak self] in
            guard let self else { throw APIError.cancelled }
            defer { Task { @MainActor in self.refreshTask = nil } }

            guard let refresh = try? self.secrets.get(.refreshToken) else {
                throw APIError.server(
                    code: .reauthenticationRequired,
                    message: "There is no saved session to refresh.",
                    recoverable: false,
                    requestId: nil)
            }
            return try await self.performRefresh(using: refresh)
        }

        refreshTask = task
        return task
    }
}

// MARK: - Presentation anchor

extension AuthenticationService: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            return scene?.keyWindow ?? ASPresentationAnchor()
        }
    }
}
