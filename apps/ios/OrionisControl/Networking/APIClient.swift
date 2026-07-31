import Foundation
import Network
import os

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
}

struct Paged<T: Decodable & Sendable>: Decodable, Sendable {
    let items: [T]
    let page: PageMeta
}

/// A single API call.
struct Endpoint: Sendable {
    enum Method: String, Sendable {
        case get = "GET", post = "POST", put = "PUT", delete = "DELETE"
    }

    var method: Method = .get
    var path: String
    var query: [String: String?] = [:]
    var body: Encodable?
    var headers: [String: String] = [:]
    /// Sensitive writes carry one so a retry can never execute twice.
    var idempotencyKey: String?
    /// Disruptive operations must be explicitly confirmed.
    var confirmDisruptive = false
    var timeout: TimeInterval = 20
    /// Retrying is opt-in per endpoint, never automatic for writes.
    var isRetryable = false
}

/// Watches the network path so the app can distinguish "offline" from "broken".
actor NetworkMonitor {
    private let monitor = NWPathMonitor()
    private var current: NWPath?

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { await self?.update(path) }
        }
        monitor.start(queue: DispatchQueue(label: "com.lostmediastudios.orioniscontrol.network"))
    }

    private func update(_ path: NWPath) { current = path }

    var isConnected: Bool { current?.status == .satisfied }
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
        _ = try? await perform(endpoint, as: Empty.self, authenticated: true, allowRefresh: true)
    }

    /// Raw bytes (snapshots).
    func requestData(_ endpoint: Endpoint) async throws -> Data {
        guard await monitor.isConnected else { throw APIError.offline }
        var request = try buildRequest(endpoint)
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
            return data
        } catch let error as URLError {
            throw APIError.from(urlError: error)
        }
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
            if endpoint.isRetryable, mapped.isRetryable, attempt < 2 {
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
                await provider.handleAuthenticationFailure(apiError)
                throw apiError
            }
        }

        if apiError.requiresReauthentication {
            await tokenProvider?.handleAuthenticationFailure(apiError)
        }

        // Server-side transient failures: retry reads only.
        if endpoint.isRetryable, apiError.isRetryable, attempt < 2,
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
private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void
    init(_ wrapped: Encodable) { encodeClosure = wrapped.encode }
    func encode(to encoder: Encoder) throws { try encodeClosure(encoder) }
}

extension ISO8601DateFormatter {
    static let orionisWithFractionalSeconds: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static let orionisPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
