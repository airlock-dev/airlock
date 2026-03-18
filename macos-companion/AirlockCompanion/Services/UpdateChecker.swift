import Foundation

struct UpdateCheckResult: Equatable, Sendable {
    let latestVersion: String
}

struct GitHubRelease: Decodable, Sendable {
    let tagName: String
    let isDraft: Bool
    let isPrerelease: Bool

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case isDraft = "draft"
        case isPrerelease = "prerelease"
    }
}

enum VersionComparator {
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        compare(candidate, current) == .orderedDescending
    }

    static func compare(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let lhsComponents = numericComponents(for: lhs)
        let rhsComponents = numericComponents(for: rhs)
        let count = max(lhsComponents.count, rhsComponents.count)

        for index in 0..<count {
            let lhsValue = index < lhsComponents.count ? lhsComponents[index] : 0
            let rhsValue = index < rhsComponents.count ? rhsComponents[index] : 0

            if lhsValue < rhsValue { return .orderedAscending }
            if lhsValue > rhsValue { return .orderedDescending }
        }

        return .orderedSame
    }

    private static func numericComponents(for version: String) -> [Int] {
        let coreVersion = version.split(separator: "-", maxSplits: 1).first.map(String.init) ?? version

        return coreVersion
            .split(separator: ".")
            .map { component in
                let digits = component.filter(\.isNumber)
                return Int(digits) ?? 0
            }
    }
}

final class UpdateChecker: Sendable {
    private let session: URLSession
    private let releasesURL: URL

    init(session: URLSession = .shared, releasesURL: URL = Constants.Updates.releasesURL) {
        self.session = session
        self.releasesURL = releasesURL
    }

    func checkForUpdate(currentVersion: String) async throws -> UpdateCheckResult? {
        var request = URLRequest(url: releasesURL)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("AirlockCompanion", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }

        let releases = try JSONDecoder().decode([GitHubRelease].self, from: data)

        guard let latestVersion = Self.latestCompanionVersion(from: releases) else {
            return nil
        }

        guard VersionComparator.isNewer(latestVersion, than: currentVersion) else {
            return nil
        }

        return UpdateCheckResult(latestVersion: latestVersion)
    }

    static func latestCompanionVersion(from releases: [GitHubRelease]) -> String? {
        releases
            .lazy
            .filter { !$0.isDraft && !$0.isPrerelease }
            .compactMap { normalizedVersion(from: $0.tagName) }
            .max { VersionComparator.compare($0, $1) == .orderedAscending }
    }

    static func normalizedVersion(from tagName: String) -> String? {
        guard tagName.hasPrefix(Constants.Updates.tagPrefix) else {
            return nil
        }

        let version = String(tagName.dropFirst(Constants.Updates.tagPrefix.count))
        return version.isEmpty ? nil : version
    }
}
