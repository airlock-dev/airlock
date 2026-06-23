import Foundation

struct AirlockAPIClient: Sendable {
    var baseURL: URL
    var bearerToken: String?

    func registerDevice(name: String, pushToken: String, adminSecret: String) async throws -> DeviceRegistrationResponse {
        struct Body: Encodable {
            let name: String
            let platform: String
            let pushToken: String
        }

        var client = self
        client.bearerToken = adminSecret
        return try await client.request(
            path: "/mobile/devices/register",
            method: "POST",
            body: Body(name: name, platform: "ios", pushToken: pushToken),
            response: DeviceRegistrationResponse.self
        )
    }

    func updateDevicePushToken(_ pushToken: String) async throws {
        struct Body: Encodable {
            let pushToken: String
        }

        let _: EmptyResponse = try await request(
            path: "/mobile/device",
            method: "PUT",
            body: Body(pushToken: pushToken),
            response: EmptyResponse.self
        )
    }

    func unregisterCurrentDevice() async throws {
        let _: EmptyResponse = try await request(
            path: "/mobile/device",
            method: "DELETE",
            body: Optional<EmptyBody>.none,
            response: EmptyResponse.self
        )
    }

    func pendingApprovals() async throws -> [ApprovalRequest] {
        let response = try await request(
            path: "/mobile/approvals",
            method: "GET",
            body: Optional<EmptyBody>.none,
            response: ApprovalListResponse.self
        )
        return response.approvals
    }

    func approvalHistory(limit: Int = 50) async throws -> [ApprovalRequest] {
        let response = try await request(
            path: "/mobile/approvals/history?limit=\(limit)",
            method: "GET",
            body: Optional<EmptyBody>.none,
            response: ApprovalListResponse.self
        )
        return response.approvals
    }

    func activityEvents() async throws -> [ActivityEvent] {
        let response = try await request(
            path: "/mobile/activity",
            method: "GET",
            body: Optional<EmptyBody>.none,
            response: ActivityListResponse.self
        )
        return response.events
    }

    func decide(
        id: String,
        decision: ApprovalDecision,
        remember: RememberMode? = nil,
        durationMs: Int? = nil,
        reason: String? = nil
    ) async throws {
        let body = DecisionRequest(
            decision: decision,
            remember: remember,
            durationMs: durationMs,
            reason: reason
        )
        let _: EmptyResponse = try await request(
            path: "/mobile/approvals/\(id)/decision",
            method: "POST",
            body: body,
            response: EmptyResponse.self
        )
    }

    private func request<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        body: Body?,
        response: Response.Type
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONEncoder.airlock.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, urlResponse) = try await URLSession.shared.data(for: request)
        guard let httpResponse = urlResponse as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
            throw AirlockAPIError.server(message)
        }
        if response == EmptyResponse.self, data.isEmpty || data == Data("{}".utf8) {
            return EmptyResponse() as! Response
        }
        return try JSONDecoder.airlock.decode(Response.self, from: data)
    }
}

enum AirlockAPIError: Error, LocalizedError {
    case server(String)

    var errorDescription: String? {
        switch self {
        case .server(let message):
            return message
        }
    }
}

private struct EmptyBody: Encodable {}

struct EmptyResponse: Decodable {
    init() {}
}

extension JSONDecoder {
    static var airlock: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = ISO8601DateFormatter.airlockWithFractionalSeconds.date(from: value) {
                return date
            }
            if let date = ISO8601DateFormatter.airlock.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO8601 date: \(value)"
            )
        }
        return decoder
    }
}

extension JSONEncoder {
    static var airlock: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

private extension ISO8601DateFormatter {
    static let airlockWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let airlock: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
