import Foundation
import Network
import os

extension Notification.Name {
    static let orionisNetworkPathChanged = Notification.Name("OrionisNetworkPathChanged")
}

/// Response envelopes, matching the gateway exactly.
struct SuccessEnvelope<T: Decodable>: Decodable {
    let success: Bool
    let data: T
    let requestId: String
    let serverTime: Date
}

struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        let code: String
        let message: String
        let recoverable: Bool
    }
    let success: Bool
    let error: Body
    let requestId: String
}

struct PageMeta: Decodable, Sendable, Equatable {
    let total: Int?
    let limit: Int
    let offset: Int
    let hasMore: Bool
    let nextCursor: String?
}

struct Paged<T: Decodable & Sendable>: Decodable, Sendable {
    let items: [T]
    let page: PageMeta
}

/// A single API call.
struct Endpoint: Sendable {
    enum Method: String, Sendable {
        case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
    }

    var method: Method = .get
    var path: String
    var query: [String: String?] = [:]
    /// Sendable so `Endpoint` genuinely is: every body passed is a value type.
    var body: (any Encodable & Sendable)?
    var headers: [String: String] = [:]
    /// Sensitive writes carry one so a retry can never execute twice.
    var idempotencyKey: String?
    /// Disruptive operations must be explicitly confirmed.
    var confirmDisruptive = false
    var timeout: TimeInterval = 20
    /// Retrying is opt-in per endpoint, never automatic for writes.
    var isRetryable = false
    /// Hard ceiling on retry attempts for a retryable read; total requests sent
    /// is `maxRetries + 1`. Keep this small (ideally 1) for anything a person is
    /// actively waiting on, so a dead or slow upstream fails in seconds rather
    /// than stacking full timeouts into minutes.
    var maxRetries = 2
}

/// Watches the network path so the app can distinguish "offline" from "broken".
actor NetworkMonitor {
    private let monitor = NWPathMonitor()
    private var current: NWPath?
    private var pathSignature: String?

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { await self?.update(path) }
        }
        monitor.start(queue: DispatchQueue(label: "com.lostmediastudios.orioniscontrol.network"))
    }

    private func update(_ path: NWPath) {
        let signature = [
            String(describing: path.status),
            path.isExpensive ? "expensive" : "normal",
            path.isConstrained ? "constrained" : "unconstrained",
            path.usesInterfaceType(.wifi) ? "wifi" : "",
            path.usesInterfaceType(.cellular) ? "cellular" : "",
            path.usesInterfaceType(.wiredEthernet) ? "wired" : "",
        ].joined(separator: "|")
        let shouldNotify = pathSignature != nil && pathSignature != signature
        current = path
        pathSignature = signature
        if shouldNotify {
            Task { @MainActor in
                NotificationCenter.default.post(name: .orionisNetworkPathChanged, object: nil)
            }
        }
    }

    /// Until the first NWPath callback arrives, connectivity is unknown rather
    /// than offline. Be optimistic and let URLSession make the real request;
    /// otherwise a cold launch can fail immediately with a false offline error.
    var isConnected: Bool {
        guard let current else { return true }
        return current.status == .satisfied
    }
    var isExpensive: Bool { current?.isExpensive ?? false }
    var isConstrained: Bool { current?.isConstrained ?? false }

    /// True when the app should limit stream quality and background refresh.
    var shouldConserveData: Bool { isExpensive || isConstrained }
}

/// Supplies a valid access token, refreshing when necessary.
protocol TokenProviding: Sendable {
    func validAccessToken() async throws -> String
    func refreshAccessToken() async throws -> String
    func handleAuthenticationFailure(_ error: APIError) async
}

/// The gateway client.
///
/// One place that knows about envelopes, dates, auth headers, retry policy and
/// error mapping — so no feature ever has to.
actor APIClient {
    private let session: URLSession
    private let monitor: NetworkMonitor
    private let logger = Logger(subsystem: "com.lostmediastudios.orioniscontrol", category: "api")

    private var baseURL: URL
    private var tokenProvider: TokenProviding?

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = ISO8601DateFormatter.orionisWithFractionalSeconds.date(from: raw) {
                return date
            }
            if let date = ISO8601DateFormatter.orionisPlain.date(from: raw) {
                return date
            }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unrecognised date: \(raw)")
            )
        }
        return d
    }()

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    init(baseURL: URL, monitor: NetworkMonitor = NetworkMonitor(), session: URLSession? = nil) {
        self.baseURL = baseURL
        self.monitor = monitor

        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.waitsForConnectivity = false
            config.timeoutIntervalForRequest = 20
            config.timeoutIntervalForResource = 60
            config.httpAdditionalHeaders = ["accept": "application/json"]
            // No cookies: this client is token-authenticated only, which also
            // removes a whole class of session-fixation and CSRF concerns.
            config.httpCookieAcceptPolicy = .never
            config.httpShouldSetCookies = false
            self.session = URLSession(configuration: config)
        }
    }

    func setBaseURL(_ url: URL) { baseURL = url }
    func setTokenProvider(_ provider: TokenProviding?) { tokenProvider = provider }

    var currentBaseURL: URL { baseURL }

    /// A fully-qualified URL for a media sub-resource (e.g. a recording clip)
    /// together with a bearer header valid at call time. AVFoundation fetches
    /// media directly and cannot go through `request(...)`, so it needs both the
    /// absolute URL and the auth header handed to it explicitly — exactly as live
    /// playback does with its per-stream token.
    func authorizedMedia(path: String, query: [String: String] = [:]) async throws -> (
        url: URL, headers: [String: String]
    ) {
        var components = URLComponents(
            url: baseURL.appending(path: "api/mobile/v1" + path), resolvingAgainstBaseURL: false)
        if !query.isEmpty {
            components?.queryItems = query
                .sorted { $0.key < $1.key }
                .map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components?.url else {
            throw APIError.configuration("Could not build a media URL.")
        }
        var headers: [String: String] = [:]
        if let token = try await tokenProvider?.validAccessToken() {
            headers["Authorization"] = "Bearer \(token)"
        }
        return (url, headers)
    }
    var conservingData: Bool { get async { await monitor.shouldConserveData } }

    // MARK: - Requests

    /// Unauthenticated call — used only for /meta and /health during setup.
    func requestPublic<T: Decodable & Sendable>(_ endpoint: Endpoint, as type: T.Type) async throws
        -> T
    {
        try await perform(endpoint, as: type, authenticated: false, allowRefresh: false)
    }

    func request<T: Decodable & Sendable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T {
        try await perform(endpoint, as: type, authenticated: true, allowRefresh: true)
    }

    /// For endpoints that return no body.
    func requestVoid(_ endpoint: Endpoint) async throws {
        struct Empty: Decodable, Sendable {}
        // `Empty` ignores fields in the server's data object, but transport,
        // authentication and server errors must still reach the caller. The old
        // `try?` made every destructive write appear successful when it failed.
        _ = try await perform(endpoint, as: Empty.self, authenticated: true, allowRefresh: true)
    }

    /// Raw bytes (snapshots).
    func requestData(_ endpoint: Endpoint) async throws -> (data: Data, capturedAt: String?) {
        guard await monitor.isConnected else { throw APIError.offline }
        var request = try buildRequest(endpoint)
        // Raw data is currently camera imagery. A user-initiated refresh must not
        // be satisfied by URLCache's still-valid five-second response.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let token = try await tokenProvider?.validAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.decoding("The response was not an HTTP response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                throw try mapErrorResponse(data: data, status: http.statusCode)
            }
            return (data, http.value(forHTTPHeaderField: "x-captured-at"))
        } catch let error as URLError {
            throw APIError.from(urlError: error)
        }
    }

    /// A disk-backed download plus the server's suggested filename.
    ///
    /// The filename matters: a clip saved out of the app is looked at weeks later,
    /// and the gateway already names it after the camera and the moment it covers.
    /// Falls back to nil rather than guessing, so the caller decides.
    func requestDownload(_ endpoint: Endpoint) async throws -> (fileURL: URL, filename: String?) {
        guard await monitor.isConnected else { throw APIError.offline }
        var request = try buildRequest(endpoint)
        if let token = try await tokenProvider?.validAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }

        do {
            let (temporaryURL, response) = try await session.download(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.decoding("The response was not an HTTP response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                let data = (try? Data(contentsOf: temporaryURL)) ?? Data()
                throw try mapErrorResponse(data: data, status: http.statusCode)
            }
            let filename = Self.filename(
                fromContentDisposition: http.value(forHTTPHeaderField: "content-disposition"))
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
                ".orionis-download-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: false)
            let destination = directory.appendingPathComponent(filename ?? "download")
            do {
                try FileManager.default.moveItem(at: temporaryURL, to: destination)
            } catch {
                try? FileManager.default.removeItem(at: directory)
                throw error
            }
            return (destination, filename)
        } catch let error as URLError {
            throw APIError.from(urlError: error)
        }
    }

    /// Pulls `filename="…"` out of a Content-Disposition header.
    ///
    /// Deliberately strict about path separators: the name goes on to be used as a
    /// filename, and a server-supplied value must not be able to escape the
    /// directory it is written into.
    static func filename(fromContentDisposition header: String?) -> String? {
        guard let header else { return nil }
        guard
            let range = header.range(
                of: #"filename\*?=\"?([^\";]+)"#, options: .regularExpression)
        else { return nil }
        let raw = String(header[range])
            .replacingOccurrences(of: "filename*=", with: "")
            .replacingOccurrences(of: "filename=", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "\" "))
        let cleaned = raw
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: "\\", with: "-")
            .replacingOccurrences(of: "..", with: "-")
        return cleaned.isEmpty ? nil : cleaned
    }

    // MARK: - Core

    private func perform<T: Decodable & Sendable>(
        _ endpoint: Endpoint,
        as type: T.Type,
        authenticated: Bool,
        allowRefresh: Bool,
        attempt: Int = 0
    ) async throws -> T {
        guard await monitor.isConnected else { throw APIError.offline }

        var request = try buildRequest(endpoint)

        if authenticated {
            guard let provider = tokenProvider else {
                throw APIError.server(
                    code: .unauthenticated,
                    message: "This request requires a signed-in session.",
                    recoverable: false,
                    requestId: nil
                )
            }
            let token = try await provider.validAccessToken()
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }

        let data: Data
        let http: HTTPURLResponse
        do {
            let (d, response) = try await session.data(for: request)
            guard let h = response as? HTTPURLResponse else {
                throw APIError.decoding("The response was not an HTTP response.")
            }
            data = d
            http = h
        } catch let error as URLError {
            let mapped = APIError.from(urlError: error)
            // Only idempotent reads are retried, and only for transport faults.
            if endpoint.isRetryable, mapped.isRetryable, attempt < endpoint.maxRetries {
                try await backoff(attempt: attempt)
                return try await perform(
                    endpoint, as: type, authenticated: authenticated,
                    allowRefresh: allowRefresh, attempt: attempt + 1)
            }
            throw mapped
        }

        if (200..<300).contains(http.statusCode) {
            do {
                return try decoder.decode(SuccessEnvelope<T>.self, from: data).data
            } catch {
                logger.error("decoding failed for \(endpoint.path, privacy: .public)")
                throw APIError.decoding(shortDecodingDescription(error))
            }
        }

        let apiError = try mapErrorResponse(data: data, status: http.statusCode)

        // A single transparent refresh, then give up and surface the error.
        if case .server(let code, _, _, _) = apiError, code == .tokenExpired, allowRefresh,
            authenticated, let provider = tokenProvider
        {
            do {
                _ = try await provider.refreshAccessToken()
                return try await perform(
                    endpoint, as: type, authenticated: authenticated,
                    allowRefresh: false, attempt: attempt)
            } catch {
                // A failed refresh only means "sign in again" when the gateway
                // actually rejected the session. A transient network failure here
                // (offline/timeout/unreachable during a Wi-Fi↔cellular switch) must
                // not destroy it — surface the error and let the caller retry.
                let refreshRejected = (error as? APIError)?.requiresReauthentication ?? false
                if refreshRejected {
                    await provider.handleAuthenticationFailure(apiError)
                    throw apiError
                }
                throw (error as? APIError) ?? apiError
            }
        }

        if apiError.requiresReauthentication {
            await tokenProvider?.handleAuthenticationFailure(apiError)
        }

        // Server-side transient failures: retry reads only.
        if endpoint.isRetryable, apiError.isRetryable, attempt < endpoint.maxRetries,
            endpoint.method == .get
        {
            try await backoff(attempt: attempt)
            return try await perform(
                endpoint, as: type, authenticated: authenticated,
                allowRefresh: allowRefresh, attempt: attempt + 1)
        }

        throw apiError
    }

    private func backoff(attempt: Int) async throws {
        // 400ms, 1200ms — bounded, with jitter to avoid thundering herds.
        let base = 0.4 * pow(3.0, Double(attempt))
        let jitter = Double.random(in: 0...0.2)
        try await Task.sleep(for: .seconds(base + jitter))
    }

    private func buildRequest(_ endpoint: Endpoint) throws -> URLRequest {
        guard
            var components = URLComponents(
                url: baseURL.appending(path: "api/mobile/v1" + endpoint.path),
                resolvingAgainstBaseURL: false)
        else {
            throw APIError.configuration("The gateway address could not be used to build a request.")
        }

        let items = endpoint.query.compactMap { key, value -> URLQueryItem? in
            guard let value, !value.isEmpty else { return nil }
            return URLQueryItem(name: key, value: value)
        }
        if !items.isEmpty { components.queryItems = items.sorted { $0.name < $1.name } }

        guard let url = components.url else {
            throw APIError.configuration("The request URL could not be constructed.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.timeoutInterval = endpoint.timeout
        for (key, value) in endpoint.headers { request.setValue(value, forHTTPHeaderField: key) }

        if let key = endpoint.idempotencyKey {
            request.setValue(key, forHTTPHeaderField: "idempotency-key")
        }
        if endpoint.confirmDisruptive {
            request.setValue("true", forHTTPHeaderField: "x-confirm-disruptive")
        }
        if let body = endpoint.body {
            request.httpBody = try encoder.encode(AnyEncodable(body))
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        return request
    }

    private func mapErrorResponse(data: Data, status: Int) throws -> APIError {
        if let envelope = try? decoder.decode(ErrorEnvelope.self, from: data),
            let code = APIErrorCode(rawValue: envelope.error.code)
        {
            return .server(
                code: code,
                message: envelope.error.message,
                recoverable: envelope.error.recoverable,
                requestId: envelope.requestId
            )
        }
        return .unexpectedStatus(status, requestId: nil)
    }

    private func shortDecodingDescription(_ error: Error) -> String {
        guard let decodingError = error as? DecodingError else { return "unexpected shape" }
        switch decodingError {
        case .keyNotFound(let key, _): return "missing field '\(key.stringValue)'"
        case .typeMismatch(_, let context):
            return "unexpected type at '\(context.codingPath.map(\.stringValue).joined(separator: "."))'"
        case .valueNotFound(_, let context):
            return "missing value at '\(context.codingPath.map(\.stringValue).joined(separator: "."))'"
        case .dataCorrupted(let context): return context.debugDescription
        @unknown default: return "unexpected shape"
        }
    }
}

/// Type-erasing wrapper so `Endpoint.body` can hold any Encodable.
private struct AnyEncodable: Encodable, @unchecked Sendable {
    private let encodeClosure: @Sendable (Encoder) throws -> Void
    init(_ wrapped: any Encodable & Sendable) {
        encodeClosure = { encoder in try wrapped.encode(to: encoder) }
    }
    func encode(to encoder: Encoder) throws { try encodeClosure(encoder) }
}

extension ISO8601DateFormatter {
    // These are shared deliberately: constructing a formatter is expensive and
    // these are only ever asked to format or parse, which Foundation's formatters
    // support concurrently. `nonisolated(unsafe)` records that judgement instead of
    // leaving a bare concurrency warning that looks unexamined.
    nonisolated(unsafe) static let orionisWithFractionalSeconds: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated(unsafe) static let orionisPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
