import Foundation

enum ApprovalRememberMode: String, Sendable {
    case temporary
    case always
}

/// Non-2xx response, carrying the server's `{ error }` message when there is one.
struct AirlockAPIError: LocalizedError, Equatable {
    let statusCode: Int
    let message: String?

    var errorDescription: String? {
        message ?? "Server returned HTTP \(statusCode)"
    }
}

/// Result of approving one request. `approved` can include other pending ids the new grant covered.
struct ApprovalDecisionOutcome: Decodable, Equatable, Sendable {
    var approved: [String] = []
    var grant: ApprovalGrant? = nil

    enum CodingKeys: String, CodingKey {
        case approved, grant
    }

    init(approved: [String] = [], grant: ApprovalGrant? = nil) {
        self.approved = approved
        self.grant = grant
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approved = ((try? container.decodeIfPresent([String].self, forKey: .approved)) ?? nil) ?? []
        grant = try? container.decodeIfPresent(ApprovalGrant.self, forKey: .grant)
    }
}

/// Result of a bulk or batch decision.
struct BulkDecisionOutcome: Decodable, Equatable, Sendable {
    var approved: [String] = []
    var skipped: [String] = []
    var denied: [String] = []

    enum CodingKeys: String, CodingKey {
        case approved, skipped, denied
    }

    init(approved: [String] = [], skipped: [String] = [], denied: [String] = []) {
        self.approved = approved
        self.skipped = skipped
        self.denied = denied
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approved = ((try? container.decodeIfPresent([String].self, forKey: .approved)) ?? nil) ?? []
        skipped = ((try? container.decodeIfPresent([String].self, forKey: .skipped)) ?? nil) ?? []
        denied = ((try? container.decodeIfPresent([String].self, forKey: .denied)) ?? nil) ?? []
    }
}

final class AirlockAPIClient: Sendable {
    private let connection: DashboardConnection

    init(baseURL: String = Constants.defaultDashboardURL, bearerToken: String? = nil) {
        self.connection = DashboardConnection(baseURL: baseURL, bearerToken: bearerToken)
    }

    @discardableResult
    func approve(
        id: String,
        remember: ApprovalRememberMode? = nil,
        durationMs: Int? = nil,
        grant: GrantSpec? = nil
    ) async throws -> ApprovalDecisionOutcome {
        let request = try makeDecisionRequest(
            id: id, decision: "approved", remember: remember, durationMs: durationMs, grant: grant
        )
        let data = try await send(request)
        return (try? JSONDecoder().decode(ApprovalDecisionOutcome.self, from: data))
            ?? ApprovalDecisionOutcome(approved: [id])
    }

    func deny(id: String) async throws {
        try await send(makeDecisionRequest(id: id, decision: "denied"))
    }

    /// Decide an explicit list of approvals. The server skips escalated requests on approve.
    @discardableResult
    func decide(ids: [String], decision: String, reason: String? = nil) async throws -> BulkDecisionOutcome {
        let data = try await send(makeBulkDecisionRequest(ids: ids, decision: decision, reason: reason))
        return (try? JSONDecoder().decode(BulkDecisionOutcome.self, from: data)) ?? BulkDecisionOutcome()
    }

    /// Decide a whole notification batch by batch id or code.
    @discardableResult
    func decideBatch(_ batch: String, decision: String) async throws -> BulkDecisionOutcome {
        let data = try await send(makeBatchDecisionRequest(batch: batch, decision: decision))
        return (try? JSONDecoder().decode(BulkDecisionOutcome.self, from: data)) ?? BulkDecisionOutcome()
    }

    func grants() async throws -> [ApprovalGrant] {
        let (data, response) = try await URLSession.shared.data(for: makeGrantsRequest())
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        // Older gateways have no grants route.
        if http.statusCode == 404 { return [] }
        guard (200...299).contains(http.statusCode) else {
            throw AirlockAPIError(statusCode: http.statusCode, message: Self.errorMessage(from: data))
        }
        return try JSONDecoder().decode(GrantListResponse.self, from: data).grants
    }

    func revokeGrant(id: String) async throws {
        try await send(makeRevokeGrantRequest(id: id))
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

    func approvalPreview(id: String) async throws -> ApprovalPreview {
        let request = try makePreviewRequest(id: id)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        // Older gateways have no preview route.
        if http.statusCode == 404 { return ApprovalPreview(status: "unavailable") }
        guard (200...299).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(ApprovalPreview.self, from: data)
    }

    func makePreviewRequest(id: String) throws -> URLRequest {
        let escapedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try connection.request(path: "/mobile/approvals/\(escapedId)/preview", method: "POST")
    }

    /// `remember: .temporary` is sent both as the legacy field and as a tool grant: newer gateways
    /// use the grant (no config write), older ones ignore it and keep the temporary config rule.
    func makeDecisionRequest(
        id: String,
        decision: String,
        remember: ApprovalRememberMode? = nil,
        durationMs: Int? = nil,
        grant: GrantSpec? = nil
    ) throws -> URLRequest {
        let effectiveGrant = grant
            ?? (decision == "approved" && remember == .temporary
                ? GrantSpec(scope: "tool", durationMs: durationMs)
                : nil)
        // An explicit grant replaces the legacy remember fields.
        let legacyRemember = grant == nil ? remember : nil
        return try jsonRequest(
            path: Constants.approvalDecisionPath(id: escapePath(id)),
            body: DecisionRequest(
                decision: decision,
                remember: legacyRemember?.rawValue,
                durationMs: legacyRemember == nil ? nil : durationMs,
                grant: effectiveGrant
            )
        )
    }

    func makeBulkDecisionRequest(ids: [String], decision: String, reason: String? = nil) throws -> URLRequest {
        try jsonRequest(
            path: Constants.bulkDecisionPath,
            body: BulkDecisionRequest(ids: ids, decision: decision, reason: reason)
        )
    }

    func makeBatchDecisionRequest(batch: String, decision: String) throws -> URLRequest {
        try jsonRequest(
            path: Constants.batchDecisionPath(batch: escapePath(batch)),
            body: BulkDecisionRequest(ids: nil, decision: decision, reason: nil)
        )
    }

    func makeGrantsRequest() throws -> URLRequest {
        try connection.request(path: Constants.grantsPath)
    }

    func makeRevokeGrantRequest(id: String) throws -> URLRequest {
        try connection.request(path: Constants.grantPath(id: escapePath(id)), method: "DELETE")
    }

    func makePendingRequest() throws -> URLRequest {
        try connection.request(path: Constants.pendingPath)
    }

    // MARK: - Private

    private func escapePath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func jsonRequest<Body: Encodable>(path: String, body: Body) throws -> URLRequest {
        var request = try connection.request(path: path, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    @discardableResult
    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw AirlockAPIError(statusCode: httpResponse.statusCode, message: Self.errorMessage(from: data))
        }
        return data
    }

    private static func errorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["error"] as? String
    }
}

private struct ApprovalListResponse: Decodable {
    let approvals: [ApprovalRequest]
}

private struct GrantListResponse: Decodable {
    let grants: [ApprovalGrant]
}

private struct DecisionRequest: Encodable {
    let decision: String
    let remember: String?
    let durationMs: Int?
    let grant: GrantSpec?

    enum CodingKeys: String, CodingKey {
        case decision
        case remember
        case durationMs = "duration_ms"
        case grant
    }
}

private struct BulkDecisionRequest: Encodable {
    let ids: [String]?
    let decision: String
    let reason: String?
}
