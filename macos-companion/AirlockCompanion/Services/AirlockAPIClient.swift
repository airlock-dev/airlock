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

    func approve(id: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) async throws {
        try await postDecision(id: id, decision: "approved", remember: remember, durationMs: durationMs)
    }

    func deny(id: String) async throws {
        try await postDecision(id: id, decision: "denied")
    }

    func pendingApprovals() async throws -> [ApprovalRequest] {
        let request = try makePendingRequest()
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode)
        else {
            throw URLError(.badServerResponse)
        }

        return try JSONDecoder().decode(ApprovalListResponse.self, from: data).approvals
    }

    private func postDecision(id: String, decision: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) async throws {
        let request = try makeDecisionRequest(id: id, decision: decision, remember: remember, durationMs: durationMs)
        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode)
        else {
            throw URLError(.badServerResponse)
        }
    }

    func makeDecisionRequest(id: String, decision: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) throws -> URLRequest {
        let escapedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        var request = try connection.request(
            path: Constants.approvalDecisionPath(id: escapedId),
            method: "POST"
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(DecisionRequest(
            decision: decision,
            remember: remember?.rawValue,
            durationMs: durationMs
        ))
        return request
    }

    func makePendingRequest() throws -> URLRequest {
        try connection.request(path: Constants.pendingPath)
    }
}

private struct ApprovalListResponse: Decodable {
    let approvals: [ApprovalRequest]
}

private struct DecisionRequest: Encodable {
    let decision: String
    let remember: String?
    let durationMs: Int?

    enum CodingKeys: String, CodingKey {
        case decision
        case remember
        case durationMs = "duration_ms"
    }
}
