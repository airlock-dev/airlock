import XCTest
@testable import AirlockCompanion

final class UpdateCheckerTests: XCTestCase {
    func testNormalizedVersionStripsCompanionPrefix() {
        XCTAssertEqual(UpdateChecker.normalizedVersion(from: "companion-v1.2.3"), "1.2.3")
        XCTAssertNil(UpdateChecker.normalizedVersion(from: "v1.2.3"))
    }

    func testLatestCompanionVersionIgnoresNonCompanionAndPrereleases() {
        let releases = [
            GitHubRelease(tagName: "v0.2.13", isDraft: false, isPrerelease: false),
            GitHubRelease(tagName: "companion-v1.2.0-beta.1", isDraft: false, isPrerelease: true),
            GitHubRelease(tagName: "companion-v1.1.9", isDraft: false, isPrerelease: false),
            GitHubRelease(tagName: "companion-v1.2.0", isDraft: false, isPrerelease: false)
        ]

        XCTAssertEqual(UpdateChecker.latestCompanionVersion(from: releases), "1.2.0")
    }

    func testVersionComparatorHandlesDifferentSegmentLengths() {
        XCTAssertTrue(VersionComparator.isNewer("1.2.1", than: "1.2"))
        XCTAssertTrue(VersionComparator.isNewer("1.10.0", than: "1.9.9"))
        XCTAssertFalse(VersionComparator.isNewer("1.0.0", than: "1.0.0"))
        XCTAssertFalse(VersionComparator.isNewer("1.0.0", than: "1.0.1"))
    }
}
