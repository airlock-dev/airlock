import Foundation

enum ApprovalRememberMode: String, Sendable {
    case temporary
    case always
}

final class AirlockAPIClient: Sendable {
    private let connection: DashboardConnection

    init(baseURL: String = Constants.defaultDashboardURL, bearerToken: String? = nil) {
        self.connection = DashboardConnection(baseURL: baseURL, bearerToken: bearerToken)
    }

    func approve(code: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) async throws {
        try await post(path: Constants.approvePath, code: code, remember: remember, durationMs: durationMs)
    }

    func deny(code: String) async throws {
        try await post(path: Constants.denyPath, code: code)
    }

    func pendingApprovalCodes() async throws -> Set<String> {
        let request = try makePendingRequest()
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode)
        else {
            throw URLError(.badServerResponse)
        }

        let pending = try JSONDecoder().decode([PendingApprovalSummary].self, from: data)
        return Set(pending.map(\.code))
    }

    private func post(path: String, code: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) async throws {
        var queryItems = [URLQueryItem(name: "code", value: code)]
        if let remember {
            queryItems.append(URLQueryItem(name: "remember", value: remember.rawValue))
        }
        if let durationMs {
            queryItems.append(URLQueryItem(name: "duration_ms", value: String(durationMs)))
        }
        let request = try makePostRequest(path: path, queryItems: queryItems)
        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode)
        else {
            throw URLError(.badServerResponse)
        }
    }

    func makePostRequest(path: String, queryItems: [URLQueryItem]) throws -> URLRequest {
        try connection.request(path: path, method: "POST", queryItems: queryItems)
    }

    func makePendingRequest() throws -> URLRequest {
        try connection.request(path: Constants.pendingPath)
    }
}

private struct PendingApprovalSummary: Decodable {
    let code: String
}
