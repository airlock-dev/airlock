import Foundation

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

    private var normalizedBaseURL: String {
        var value = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") {
            value.removeLast()
        }
        return value
    }
}
