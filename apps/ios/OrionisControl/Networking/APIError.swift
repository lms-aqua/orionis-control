import Foundation

/// The server's error taxonomy, mirrored so the UI can react precisely.
enum APIErrorCode: String, Codable, Sendable {
    case unauthenticated = "UNAUTHENTICATED"
    case tokenExpired = "TOKEN_EXPIRED"
    case sessionRevoked = "SESSION_REVOKED"
    case reauthenticationRequired = "REAUTHENTICATION_REQUIRED"
    case forbidden = "FORBIDDEN"
    case insufficientRole = "INSUFFICIENT_ROLE"
    case accountLocked = "ACCOUNT_LOCKED"
    case oauthStateInvalid = "OAUTH_STATE_INVALID"
    case oauthExchangeFailed = "OAUTH_EXCHANGE_FAILED"
    case pkceVerificationFailed = "PKCE_VERIFICATION_FAILED"
    case redirectURINotAllowed = "REDIRECT_URI_NOT_ALLOWED"
    case authorizationCodeInvalid = "AUTHORIZATION_CODE_INVALID"
    case validationFailed = "VALIDATION_FAILED"
    case notFound = "NOT_FOUND"
    case conflict = "CONFLICT"
    case ruleDuplicate = "RULE_DUPLICATE"
    case ruleInvalid = "RULE_INVALID"
    case idempotencyConflict = "IDEMPOTENCY_CONFLICT"
    case rateLimited = "RATE_LIMITED"
    case unsupportedAPIVersion = "UNSUPPORTED_API_VERSION"
    case serviceNotConfigured = "SERVICE_NOT_CONFIGURED"
    case upstreamUnavailable = "UPSTREAM_UNAVAILABLE"
    case upstreamTimeout = "UPSTREAM_TIMEOUT"
    case upstreamError = "UPSTREAM_ERROR"
    case circuitOpen = "CIRCUIT_OPEN"
    case capabilityUnsupported = "CAPABILITY_UNSUPPORTED"
    case cameraOffline = "CAMERA_OFFLINE"
    case streamUnavailable = "STREAM_UNAVAILABLE"
    case streamTokenExpired = "STREAM_TOKEN_EXPIRED"
    case pushNotConfigured = "PUSH_NOT_CONFIGURED"
    case internalError = "INTERNAL_ERROR"
}

/// Everything that can go wrong between a tap and a rendered result.
enum APIError: Error, Equatable, Sendable {
    /// A structured error the gateway returned.
    case server(code: APIErrorCode, message: String, recoverable: Bool, requestId: String?)
    /// The gateway returned a status we have no typed code for.
    case unexpectedStatus(Int, requestId: String?)
    /// The device has no usable network path.
    case offline
    /// The request exceeded its deadline.
    case timedOut
    /// TLS or certificate validation failed. Never bypassed.
    case insecureConnection(String)
    /// The response did not match the contract.
    case decoding(String)
    /// The configured gateway address is unusable.
    case configuration(String)
    /// The user (or the system) cancelled.
    case cancelled

    // MARK: - Presentation

    /// Short, human title for an error state. Never "Something went wrong".
    var title: String {
        switch self {
        case .server(let code, _, _, _):
            switch code {
            case .unauthenticated, .tokenExpired, .reauthenticationRequired:
                "Sign-in required"
            case .sessionRevoked:
                "Session ended"
            case .forbidden, .insufficientRole:
                "Not permitted"
            case .accountLocked:
                "Account locked"
            case .serviceNotConfigured:
                "Not connected"
            case .capabilityUnsupported:
                "Not supported"
            case .cameraOffline:
                "Camera offline"
            case .streamUnavailable, .streamTokenExpired:
                "Stream unavailable"
            case .upstreamTimeout:
                "Timed out"
            case .upstreamUnavailable, .circuitOpen:
                "Service unavailable"
            case .rateLimited:
                "Too many requests"
            case .ruleDuplicate:
                "Already exists"
            case .ruleInvalid, .validationFailed:
                "Invalid request"
            case .notFound:
                "Not found"
            case .unsupportedAPIVersion:
                "Update required"
            default:
                "Request failed"
            }
        case .unexpectedStatus: "Unexpected response"
        case .offline: "No connection"
        case .timedOut: "Timed out"
        case .insecureConnection: "Insecure connection"
        case .decoding: "Unreadable response"
        case .configuration: "Configuration problem"
        case .cancelled: "Cancelled"
        }
    }

    /// What happened, in the user's terms.
    var message: String {
        switch self {
        case .server(_, let message, _, _): message
        case .unexpectedStatus(let status, _):
            "The gateway responded with status \(status), which this version of the app does not understand."
        case .offline:
            "This device has no network connection, so the request was not sent."
        case .timedOut:
            "The gateway did not respond in time. It may be busy or unreachable from this network."
        case .insecureConnection(let detail):
            "The connection could not be verified as secure (\(detail)). Orionis Control will not send credentials over an unverified connection."
        case .decoding(let detail):
            "The gateway sent a response this version of the app cannot read (\(detail)). The gateway and app versions may not match."
        case .configuration(let detail): detail
        case .cancelled: "The request was cancelled."
        }
    }

    /// What the user can do next.
    var recoverySuggestion: String? {
        switch self {
        case .server(let code, _, _, _):
            switch code {
            case .unauthenticated, .tokenExpired, .reauthenticationRequired, .sessionRevoked:
                "Sign in again to continue."
            case .insufficientRole, .forbidden:
                "Ask an administrator if you need this permission."
            case .accountLocked:
                "Contact an administrator to unlock the account."
            case .serviceNotConfigured:
                "An administrator must connect this service to the gateway."
            case .capabilityUnsupported:
                nil
            case .cameraOffline:
                "Check the camera's power and network connection."
            case .rateLimited:
                "Wait a moment and try again."
            case .upstreamTimeout, .upstreamUnavailable, .circuitOpen:
                "Try again shortly, or check the System screen for service health."
            case .unsupportedAPIVersion:
                "Update Orionis Control to a version that matches this gateway."
            case .ruleDuplicate:
                "Edit or remove the existing rule instead."
            default:
                nil
            }
        case .offline: "Reconnect to Wi-Fi or cellular and try again."
        case .timedOut: "Check your connection and try again."
        case .insecureConnection: "Check the gateway's TLS certificate."
        case .decoding: "Update the app, or ask an administrator to check the gateway version."
        case .configuration: "Review the server connection in Settings."
        case .cancelled: nil
        }
    }

    /// Whether retrying the identical request could plausibly succeed.
    /// Drives whether a "Try again" button is offered at all.
    var isRetryable: Bool {
        switch self {
        case .server(_, _, let recoverable, _): recoverable
        case .offline, .timedOut: true
        case .unexpectedStatus(let status, _): status >= 500
        case .insecureConnection, .decoding, .configuration, .cancelled: false
        }
    }

    /// Whether the app should send the user back to sign-in.
    var requiresReauthentication: Bool {
        guard case .server(let code, _, _, _) = self else { return false }
        return [.unauthenticated, .tokenExpired, .sessionRevoked, .reauthenticationRequired]
            .contains(code)
    }

    /// Whether the failure means "this feature isn't wired up", which the UI
    /// presents as an explanatory state rather than an error.
    var isNotConfigured: Bool {
        guard case .server(let code, _, _, _) = self else { return false }
        return code == .serviceNotConfigured
    }

    var isUnsupported: Bool {
        guard case .server(let code, _, _, _) = self else { return false }
        return code == .capabilityUnsupported
    }

    var requestId: String? {
        switch self {
        case .server(_, _, _, let id), .unexpectedStatus(_, let id): id
        default: nil
        }
    }

    /// Maps a URLError onto the taxonomy. TLS failures are never downgraded.
    static func from(urlError: URLError) -> APIError {
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed,
            .internationalRoamingOff:
            .offline
        case .timedOut:
            .timedOut
        case .cancelled:
            .cancelled
        case .secureConnectionFailed, .serverCertificateHasBadDate,
            .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
            .serverCertificateNotYetValid, .clientCertificateRejected,
            .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection:
            .insecureConnection(urlError.localizedDescription)
        default:
            .unexpectedStatus(urlError.errorCode, requestId: nil)
        }
    }
}
