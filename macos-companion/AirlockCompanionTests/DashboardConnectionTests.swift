import XCTest
@testable import AirlockCompanion

final class DashboardConnectionTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testDefaultDashboardURLTargetsManagementAPI() {
        XCTAssertEqual(Constants.defaultDashboardURL, "http://127.0.0.1:4113")
    }

    func testAddsTrimmedBearerToken() throws {
        let connection = DashboardConnection(
            baseURL: "http://127.0.0.1:4113/",
            bearerToken: "  gateway-secret  "
        )

        let request = try connection.request(path: Constants.healthPath)

        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:4113/health")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer gateway-secret")
    }

    func testOmitsAuthorizationHeaderWithoutToken() throws {
        let connection = DashboardConnection(baseURL: "http://127.0.0.1:4113", bearerToken: " ")

        let request = try connection.request(path: Constants.sseEventsPath)

        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func testDecisionRequestUsesMobileApiAndBearerToken() throws {
        let client = AirlockAPIClient(baseURL: "http://127.0.0.1:4113", bearerToken: "admin-token")

        let request = try client.makeDecisionRequest(
            id: "550e8400-e29b-41d4-a716-446655440000",
            decision: "approved",
            remember: .temporary,
            durationMs: 3600000
        )

        let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(components?.scheme, "http")
        XCTAssertEqual(components?.host, "127.0.0.1")
        XCTAssertEqual(components?.port, 4113)
        XCTAssertEqual(components?.path, "/mobile/approvals/550e8400-e29b-41d4-a716-446655440000/decision")
        XCTAssertNil(components?.queryItems)
        let body = try XCTUnwrap(request.httpBody)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(json?["decision"] as? String, "approved")
        XCTAssertEqual(json?["remember"] as? String, "temporary")
        XCTAssertEqual(json?["duration_ms"] as? Int, 3600000)
    }

    func testPendingRequestUsesManagementAPIAndBearerToken() throws {
        let client = AirlockAPIClient(baseURL: "http://127.0.0.1:4113", bearerToken: "admin-token")

        let request = try client.makePendingRequest()

        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:4113/mobile/approvals")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-token")
    }

    func testManagementValidationUsesAuthenticatedMobileAPI() async throws {
        let session = makeStubSession { request in
            XCTAssertEqual(request.url?.path, Constants.pendingPath)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-token")
            return HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
        }

        try await DashboardConnection(
            baseURL: "http://127.0.0.1:4113",
            bearerToken: "admin-token"
        ).validateManagementAPI(session: session)
    }

    func testManagementValidationRejectsBadTokenStatus() async throws {
        let session = makeStubSession { request in
            HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 401,
                httpVersion: nil,
                headerFields: nil
            )!
        }

        do {
            try await DashboardConnection(
                baseURL: "http://127.0.0.1:4113",
                bearerToken: "bad-token"
            ).validateManagementAPI(session: session)
            XCTFail("Expected validation to fail")
        } catch let error as DashboardConnectionStatusError {
            XCTAssertEqual(error.statusCode, 401)
        }
    }

    func testKeychainStoreUsesStableReleaseServiceWithLegacyFallbacks() {
        XCTAssertEqual(KeychainTokenStore.service, "bot.airlock.companion")
        XCTAssertEqual(KeychainTokenStore.account, "managementApiSecret")
        XCTAssertTrue(KeychainTokenStore.legacyItems.contains(.init(
            service: "dev.airlock.companion",
            account: "gatewayBearerToken"
        )))
    }

    func testSourceBundleIdentifierMatchesReleaseBundleIdentifier() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let infoURL = packageRoot
            .appendingPathComponent("AirlockCompanion")
            .appendingPathComponent("Info.plist")
        let data = try Data(contentsOf: infoURL)
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(
            from: data,
            format: nil
        ) as? [String: Any])

        XCTAssertEqual(plist["CFBundleIdentifier"] as? String, "bot.airlock.companion")
    }

    private func makeStubSession(
        handler: @escaping (URLRequest) throws -> HTTPURLResponse
    ) -> URLSession {
        StubURLProtocol.requestHandler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private final class StubURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> HTTPURLResponse)?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let requestHandler = Self.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        do {
            let response = try requestHandler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data())
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
