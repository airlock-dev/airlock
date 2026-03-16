import Foundation

final class AirlockAPIClient: Sendable {
    private let baseURL: String

    init(baseURL: String = Constants.defaultDashboardURL) {
        self.baseURL = baseURL
    }

    func approve(code: String) async throws {
        try await post(path: Constants.approvePath, code: code)
    }

    func deny(code: String) async throws {
        try await post(path: Constants.denyPath, code: code)
    }

    private func post(path: String, code: String) async throws {
        guard var components = URLComponents(string: baseURL + path) else {
            throw URLError(.badURL)
        }
        components.queryItems = [URLQueryItem(name: "code", value: code)]

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
