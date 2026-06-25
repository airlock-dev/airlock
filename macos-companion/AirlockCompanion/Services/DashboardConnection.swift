import Foundation

struct DashboardConnectionStatusError: LocalizedError, Equatable {
    let statusCode: Int

    var errorDescription: String? {
        switch statusCode {
        case 401:
            return "Authentication failed (401)"
        case 403:
            return "Authentication forbidden (403)"
        default:
            return "Server returned HTTP \(statusCode)"
        }
    }
}

struct DashboardConnection: Sendable {
    let baseURL: String
    let bearerToken: String

    init(baseURL: String = Constants.defaultDashboardURL, bearerToken: String? = nil) {
        self.baseURL = baseURL
        self.bearerToken = bearerToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func request(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        accept: String? = nil,
        timeoutInterval: TimeInterval? = nil
    ) throws -> URLRequest {
        guard var components = URLComponents(string: normalizedBaseURL + path) else {
            throw URLError(.badURL)
        }
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let accept {
            request.setValue(accept, forHTTPHeaderField: "Accept")
        }
        if let timeoutInterval {
            request.timeoutInterval = timeoutInterval
        }
        if !bearerToken.isEmpty {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    func validateHealth(session: URLSession = .shared) async throws {
        let healthStatus = try await statusCode(
            for: request(path: Constants.healthPath, timeoutInterval: 5),
            session: session
        )

        switch healthStatus {
        case 200:
            return
        case 404:
            let rootStatus = try await statusCode(
                for: request(path: "/", timeoutInterval: 5),
                session: session
            )
            guard rootStatus == 200 else {
                throw DashboardConnectionStatusError(statusCode: rootStatus)
            }
        default:
            throw DashboardConnectionStatusError(statusCode: healthStatus)
        }
    }

    func validateManagementAPI(session: URLSession = .shared) async throws {
        let status = try await statusCode(
            for: request(path: Constants.pendingPath, timeoutInterval: 5),
            session: session
        )
        guard status == 200 else {
            throw DashboardConnectionStatusError(statusCode: status)
        }
    }

    private var normalizedBaseURL: String {
        var value = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") {
            value.removeLast()
        }
        return value
    }

    private func statusCode(for request: URLRequest, session: URLSession) async throws -> Int {
        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return httpResponse.statusCode
    }
}
