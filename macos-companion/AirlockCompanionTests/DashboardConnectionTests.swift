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

    func testApprovalRequestPreservesQueryAndBearerToken() throws {
        let client = AirlockAPIClient(baseURL: "http://127.0.0.1:4113", bearerToken: "admin-token")

        let request = try client.makePostRequest(
            path: Constants.approvePath,
            queryItems: [
                URLQueryItem(name: "code", value: "ABC123"),
                URLQueryItem(name: "remember", value: "temporary"),
                URLQueryItem(name: "duration_ms", value: "3600000"),
            ]
        )

        let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-token")
        XCTAssertEqual(components?.scheme, "http")
        XCTAssertEqual(components?.host, "127.0.0.1")
        XCTAssertEqual(components?.port, 4113)
        XCTAssertEqual(components?.path, Constants.approvePath)
        XCTAssertEqual(
            components?.queryItems,
            [
                URLQueryItem(name: "code", value: "ABC123"),
                URLQueryItem(name: "remember", value: "temporary"),
                URLQueryItem(name: "duration_ms", value: "3600000"),
            ]
        )
    }
}
