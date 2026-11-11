import XCTest
@testable import AirlockCompanion

final class PendingStateTests: XCTestCase {
    private func activity(_ id: String, kind: String = "notification", at date: Date) -> ActivityEvent {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return ActivityEvent(
            id: id,
            kind: kind,
            agentId: "agent",
            title: "Title",
            body: "Body",
            severity: "info",
            createdAt: formatter.string(from: date)
        )
    }

    // MARK: - Activity notifications

    func testReplayedActivityIsNotNotifiedTwice() {
        let start = Date(timeIntervalSince1970: 1_000)
        var gate = ActivityNotificationGate(cutoff: start)
        let event = activity("a1", at: start.addingTimeInterval(5))

        XCTAssertTrue(gate.shouldNotify(event))
        // The stream replays recent activity on every reconnect.
        XCTAssertFalse(gate.shouldNotify(event))
    }

    func testActivityFromBeforeLaunchAndLogsAreNotNotified() {
        let start = Date(timeIntervalSince1970: 1_000)
        var gate = ActivityNotificationGate(cutoff: start)

        XCTAssertFalse(gate.shouldNotify(activity("old", at: start.addingTimeInterval(-60))))
        XCTAssertFalse(gate.shouldNotify(activity("log", kind: "log", at: start.addingTimeInterval(5))))
    }

    func testActivityGateForgetsOnlyBeyondCapacity() {
        let start = Date(timeIntervalSince1970: 1_000)
        var gate = ActivityNotificationGate(cutoff: start)
        gate.capacity = 2
        let first = activity("1", at: start.addingTimeInterval(1))
        XCTAssertTrue(gate.shouldNotify(first))
        XCTAssertTrue(gate.shouldNotify(activity("2", at: start.addingTimeInterval(2))))
        XCTAssertFalse(gate.shouldNotify(first))
        XCTAssertTrue(gate.shouldNotify(activity("3", at: start.addingTimeInterval(3))))
        XCTAssertTrue(gate.shouldNotify(first))
    }

    // MARK: - Pending order

    func testPendingOrderIsNewestFirstWhateverTheSource() {
        let older = ApprovalRequest(id: "old", code: "1", agentId: "a", tool: "t", args: [:], timeoutMs: 0,
                                    receivedAt: Date(timeIntervalSince1970: 100))
        let newer = ApprovalRequest(id: "new", code: "2", agentId: "a", tool: "t", args: [:], timeoutMs: 0,
                                    receivedAt: Date(timeIntervalSince1970: 200))

        // Server order (oldest first) and stream order (newest prepended) agree after ordering.
        XCTAssertEqual(AppViewModel.pendingOrder([older, newer]).map(\.id), ["new", "old"])
        XCTAssertEqual(AppViewModel.pendingOrder([newer, older]).map(\.id), ["new", "old"])
    }

    func testPendingOrderKeepsTiesInPlace() {
        let date = Date(timeIntervalSince1970: 100)
        let ids = ["a", "b", "c"]
        let requests = ids.map {
            ApprovalRequest(id: $0, code: $0, agentId: "a", tool: "t", args: [:], timeoutMs: 0, receivedAt: date)
        }
        XCTAssertEqual(AppViewModel.pendingOrder(requests).map(\.id), ids)
    }

    // MARK: - Selection

    private func requests(_ ids: [String]) -> [ApprovalRequest] {
        ids.map { ApprovalRequest(id: $0, code: $0, agentId: "a", tool: "t", args: [:], timeoutMs: 0) }
    }

    func testSelectionMovesToTheRowThatReplacesARemovedRequest() {
        // "b" was selected in row 1 of [a, b, c] and got approved.
        XCTAssertEqual(AppViewModel.selection(keeping: "b", previousRow: 1, in: requests(["a", "c"])), "c")
        // The last row was approved: the new last row is selected.
        XCTAssertEqual(AppViewModel.selection(keeping: "c", previousRow: 2, in: requests(["a", "b"])), "b")
        XCTAssertNil(AppViewModel.selection(keeping: "a", previousRow: 0, in: []))
    }

    func testSelectionFollowsItsRequestWhenTheListReorders() {
        XCTAssertEqual(AppViewModel.selection(keeping: "b", previousRow: 1, in: requests(["new", "a", "b"])), "b")
        XCTAssertNil(AppViewModel.selection(keeping: nil, previousRow: nil, in: requests(["a"])))
    }

    // MARK: - Timestamps

    func testStreamCopyWithoutTimestampsKeepsKnownDeadline() throws {
        let known = try JSONDecoder().decode(ApprovalRequest.self, from: Data("""
        { "id": "r", "code": "C", "agentId": "a", "tool": "t", "args": {}, "timeoutMs": 30000,
          "createdAt": "2026-06-25T00:00:00.000Z", "expiresAt": "2026-06-25T00:00:30.000Z" }
        """.utf8))
        let replayed = try JSONDecoder().decode(ApprovalRequest.self, from: Data("""
        { "id": "r", "code": "C", "agentId": "a", "tool": "t", "args": {}, "timeoutMs": 30000 }
        """.utf8))

        XCTAssertTrue(known.hasServerTimestamps)
        XCTAssertFalse(replayed.hasServerTimestamps)
        let merged = replayed.keepingTimestamps(of: known)
        XCTAssertEqual(merged.receivedAt, known.receivedAt)
        XCTAssertEqual(merged.deadline, known.deadline)
        XCTAssertTrue(merged.hasServerTimestamps)
    }

    func testStreamCopyWithServerTimestampsWins() throws {
        let local = ApprovalRequest(id: "r", code: "C", agentId: "a", tool: "t", args: [:], timeoutMs: 30000,
                                    receivedAt: Date(timeIntervalSince1970: 5))
        let fromServer = try JSONDecoder().decode(ApprovalRequest.self, from: Data("""
        { "id": "r", "code": "C", "agentId": "a", "tool": "t", "args": {}, "timeoutMs": 30000,
          "createdAt": "2026-06-25T00:00:00.000Z", "expiresAt": "2026-06-25T00:00:30.000Z" }
        """.utf8))

        XCTAssertEqual(fromServer.keepingTimestamps(of: local).receivedAt, fromServer.receivedAt)
        XCTAssertEqual(local.keepingTimestamps(of: nil).receivedAt, local.receivedAt)
    }

    // MARK: - Deny reason

    func testDenyCarriesMacOSReason() throws {
        let client = AirlockAPIClient(baseURL: "http://127.0.0.1:4113")
        let request = try client.makeDecisionRequest(id: "r", decision: "denied", reason: AirlockAPIClient.denyReason)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])

        XCTAssertEqual(json["decision"] as? String, "denied")
        XCTAssertEqual(json["reason"] as? String, "Denied from macOS companion")
    }
}
