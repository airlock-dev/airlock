import XCTest
@testable import AirlockCompanion

final class DashboardConnectionTests: XCTestCase {
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
}
