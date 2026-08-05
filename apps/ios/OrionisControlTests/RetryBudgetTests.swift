import XCTest

@testable import OrionisControl

/// A URLProtocol that counts every request the session actually sends and always
/// fails it as a transient timeout — the exact condition that used to let a
/// retryable read stack three full timeouts into a minutes-long hang.
private final class CountingURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var count = 0

    static func reset() {
        lock.lock()
        count = 0
        lock.unlock()
    }

    static var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    private static func bump() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        CountingURLProtocol.bump()
        client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
    }

    override func stopLoading() {}
}

final class RetryBudgetTests: XCTestCase {
    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CountingURLProtocol.self]
        let session = URLSession(configuration: config)
        return APIClient(
            baseURL: URL(string: "https://gateway.example.com")!, session: session)
    }

    /// `maxRetries: 1` must mean one initial attempt plus a single retry —
    /// exactly two requests — not the old hardcoded three.
    func testRetryableReadStopsAtMaxRetries() async {
        CountingURLProtocol.reset()
        let api = makeClient()
        do {
            _ = try await api.requestPublic(
                Endpoint(path: "/meta", isRetryable: true, maxRetries: 1),
                as: GatewayMeta.self)
            XCTFail("expected the request to fail once its retry budget is spent")
        } catch {
            // Expected: still a transport fault after the single retry.
        }
        XCTAssertEqual(CountingURLProtocol.requestCount, 2)
    }

    /// `maxRetries: 0` fails fast: a single request, no retry.
    func testZeroRetriesSendsExactlyOneRequest() async {
        CountingURLProtocol.reset()
        let api = makeClient()
        do {
            _ = try await api.requestPublic(
                Endpoint(path: "/meta", isRetryable: true, maxRetries: 0),
                as: GatewayMeta.self)
            XCTFail("expected the request to fail")
        } catch {}
        XCTAssertEqual(CountingURLProtocol.requestCount, 1)
    }

    /// A non-retryable read ignores `maxRetries` entirely and is sent once.
    func testNonRetryableReadIgnoresBudget() async {
        CountingURLProtocol.reset()
        let api = makeClient()
        do {
            _ = try await api.requestPublic(
                Endpoint(path: "/meta", isRetryable: false, maxRetries: 5),
                as: GatewayMeta.self)
            XCTFail("expected the request to fail")
        } catch {}
        XCTAssertEqual(CountingURLProtocol.requestCount, 1)
    }
}
