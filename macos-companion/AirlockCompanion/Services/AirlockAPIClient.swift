import Foundation

enum ApprovalRememberMode: String, Sendable {
    case temporary
    case always
}

final class AirlockAPIClient: Sendable {
    private let baseURL: String

    init(baseURL: String = Constants.defaultDashboardURL) {
        self.baseURL = baseURL
    }

    func approve(code: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) async throws {
        try await post(path: Constants.approvePath, code: code, remember: remember, durationMs: durationMs)
    }

    func deny(code: String) async throws {
        try await post(path: Constants.denyPath, code: code)
    }

    private func post(path: String, code: String, remember: ApprovalRememberMode? = nil, durationMs: Int? = nil) async throws {
        guard var components = URLComponents(string: baseURL + path) else {
            throw URLError(.badURL)
        }
        var queryItems = [URLQueryItem(name: "code", value: code)]
        if let remember {
            queryItems.append(URLQueryItem(name: "remember", value: remember.rawValue))
        }
        if let durationMs {
            queryItems.append(URLQueryItem(name: "duration_ms", value: String(durationMs)))
        }
        components.queryItems = queryItems

        guard let url = components.url else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode)
        else {
            throw URLError(.badServerResponse)
        }
    }
}
