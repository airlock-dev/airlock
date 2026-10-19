import XCTest
@testable import AirlockCompanion

/// Exercises the real API client against a running gateway. Skipped unless AIRLOCK_LIVE_URL is set.
///
///   AIRLOCK_LIVE_URL=http://127.0.0.1:4113 AIRLOCK_LIVE_TOKEN=… AIRLOCK_LIVE_STEP=batch swift test --filter LiveGatewayTests
///
/// Each step expects the gateway to hold pending approvals created by an agent beforehand:
///   batch — a burst of ≥2 routine calls from one agent plus a plan (approve all, then the plan)
///   grant — a burst of ≥2 calls to one tool (approve one with a tool grant; the rest auto-approve)
final class LiveGatewayTests: XCTestCase {
    private var client: AirlockAPIClient!
    private var step = ""

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["AIRLOCK_LIVE_URL"] else { throw XCTSkip("AIRLOCK_LIVE_URL not set") }
        client = AirlockAPIClient(baseURL: url, bearerToken: env["AIRLOCK_LIVE_TOKEN"])
        step = env["AIRLOCK_LIVE_STEP"] ?? ""
    }

    func testBatchApproveAllThenPlan() async throws {
        try XCTSkipUnless(step == "batch")
        let pending = try await client.pendingApprovals()
        let group = try XCTUnwrap(ApprovalGroup.groups(from: pending).first)
        let plan = try XCTUnwrap(pending.first(where: \.isPlan))
        XCTAssertFalse(group.approvableIds.contains(plan.id), "plans are decided individually")
        XCTAssertGreaterThanOrEqual(group.approvableIds.count, 2)
        XCTAssertNotNil(group.batchCode)

        let outcome = try await client.decide(ids: group.approvableIds, decision: "approved")
        XCTAssertEqual(Set(outcome.approved), Set(group.approvableIds))
        XCTAssertTrue(outcome.skipped.isEmpty)

        XCTAssertEqual(plan.planEntries.count, 3)
        let planOutcome = try await client.approve(id: plan.id)
        XCTAssertEqual(planOutcome.approved, [plan.id])
        let remaining = try await client.pendingApprovals()
        XCTAssertTrue(remaining.isEmpty, "left pending: \(remaining.map(\.tool))")
    }

    func testApproveWithToolGrantAutoApprovesSiblingsThenRevoke() async throws {
        try XCTSkipUnless(step == "grant")
        let pending = try await client.pendingApprovals()
        XCTAssertGreaterThanOrEqual(pending.count, 2)
        let first = try XCTUnwrap(pending.first)
        let option = try XCTUnwrap(first.grantOptions.first(where: { $0.scope == "tool" }))

        let outcome = try await client.approve(id: first.id, grant: option.spec(durationMs: 15 * 60_000))
        XCTAssertEqual(Set(outcome.approved), Set(pending.filter { $0.tool == first.tool }.map(\.id)))
        let grant = try XCTUnwrap(outcome.grant)

        let grants = try await client.grants()
        XCTAssertTrue(grants.contains { $0.id == grant.id })
        try await client.revokeGrant(id: grant.id)
        let after = try await client.grants()
        XCTAssertFalse(after.contains { $0.id == grant.id })
    }
}
