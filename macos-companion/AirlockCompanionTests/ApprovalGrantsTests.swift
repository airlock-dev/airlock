import XCTest
@testable import AirlockCompanion

final class ApprovalGrantsTests: XCTestCase {

    // MARK: - ApprovalRequest decoding

    func testDecodesGrantBatchAndTierFields() throws {
        let json = """
        {
            "id": "req-1", "code": "ALPHA-1", "agentId": "research", "tool": "gmail/read_email",
            "args": { "id": "abc" }, "timeoutMs": 60000,
            "kind": "call", "mode": "sync", "tier": "read", "provider": "gmail", "escalated": false,
            "batchId": "batch-9", "batchCode": "BRAVO-2", "batchSize": 3,
            "grantOptions": [
                { "scope": "tool", "label": "Allow gmail/read_email" },
                { "scope": "tier", "tier": "read", "label": "Allow read-only gmail tools" },
                { "scope": "profile", "profile": "mail-reader", "label": "Allow profile mail-reader" }
            ]
        }
        """
        let request = try JSONDecoder().decode(ApprovalRequest.self, from: Data(json.utf8))

        XCTAssertEqual(request.kind, "call")
        XCTAssertEqual(request.mode, "sync")
        XCTAssertEqual(request.tier, "read")
        XCTAssertEqual(request.tierLabel, "Read")
        XCTAssertEqual(request.provider, "gmail")
        XCTAssertFalse(request.escalated)
        XCTAssertEqual(request.batchId, "batch-9")
        XCTAssertEqual(request.batchCode, "BRAVO-2")
        XCTAssertEqual(request.batchSize, 3)
        XCTAssertEqual(request.groupKey, "batch:batch-9")
        XCTAssertEqual(request.grantOptions.count, 3)
        XCTAssertEqual(request.grantOptions[1].tier, "read")
        XCTAssertEqual(request.grantOptions[2].profile, "mail-reader")
        XCTAssertTrue(request.canBulkApprove)
    }

    func testLegacyRequestDecodesWithDefaults() throws {
        let json = """
        { "id": "req-1", "code": "ALPHA-1", "agentId": "a", "tool": "t", "args": {}, "timeoutMs": 0 }
        """
        let request = try JSONDecoder().decode(ApprovalRequest.self, from: Data(json.utf8))

        XCTAssertNil(request.kind)
        XCTAssertNil(request.tierLabel)
        XCTAssertFalse(request.escalated)
        XCTAssertFalse(request.isPlan)
        XCTAssertTrue(request.grantOptions.isEmpty)
        XCTAssertEqual(request.groupKey, "agent:a")
    }

    func testUnknownAndMalformedOptionalFieldsDoNotBreakDecoding() throws {
        let json = """
        {
            "id": "req-1", "code": "ALPHA-1", "agentId": "a", "tool": "t", "args": {}, "timeoutMs": 0,
            "kind": "something-new", "tier": "cosmic", "escalated": "yes",
            "plan": "not-an-array", "batchSize": "three",
            "grantOptions": [{ "label": "missing scope" }],
            "futureField": { "nested": true }
        }
        """
        let request = try JSONDecoder().decode(ApprovalRequest.self, from: Data(json.utf8))

        XCTAssertEqual(request.kind, "something-new")
        XCTAssertEqual(request.tier, "cosmic")
        XCTAssertFalse(request.escalated)
        XCTAssertNil(request.plan)
        XCTAssertNil(request.batchSize)
        XCTAssertTrue(request.grantOptions.isEmpty)
        XCTAssertEqual(request.displayTitle, "t")
    }

    func testDecodesPlanRequest() throws {
        let json = """
        {
            "id": "plan-1", "code": "PLAN-1", "agentId": "coder", "tool": "airlock/plan",
            "args": {}, "timeoutMs": 30000, "kind": "plan", "mode": "sync",
            "plan": [
                { "tool": "fs/write_file", "args": { "path": "/tmp/a", "content": "x" }, "fingerprint": "f1" },
                { "tool": "git/commit", "args": { "message": "wip" }, "fingerprint": "f2" },
                { "tool": "shell/ls" }
            ]
        }
        """
        let request = try JSONDecoder().decode(ApprovalRequest.self, from: Data(json.utf8))

        XCTAssertTrue(request.isPlan)
        XCTAssertEqual(request.planEntries.map(\.tool), ["fs/write_file", "git/commit", "shell/ls"])
        XCTAssertEqual(request.planEntries[0].fingerprint, "f1")
        XCTAssertEqual(request.planEntries[0].compactArgs, "content: \"x\", path: \"/tmp/a\"")
        XCTAssertTrue(request.planEntries[2].args.isEmpty)
        XCTAssertEqual(request.displayTitle, "Plan: 3 calls")
    }

    func testEscalatedAndQuestionRequestsAreNotBulkApprovable() throws {
        let escalatedJSON = """
        { "id": "e", "code": "E", "agentId": "a", "tool": "t", "args": {}, "timeoutMs": 0,
          "tier": "destructive", "escalated": true }
        """
        let questionJSON = """
        { "id": "q", "code": "Q", "agentId": "a", "tool": "airlock/ask_user",
          "args": { "question": "Proceed?" }, "timeoutMs": 0, "kind": "question" }
        """
        let escalated = try JSONDecoder().decode(ApprovalRequest.self, from: Data(escalatedJSON.utf8))
        let question = try JSONDecoder().decode(ApprovalRequest.self, from: Data(questionJSON.utf8))

        XCTAssertTrue(escalated.escalated)
        XCTAssertFalse(escalated.canBulkApprove)
        XCTAssertTrue(question.isUserQuestion)
        XCTAssertFalse(question.canBulkApprove)
    }

    func testSSENewEventCarriesBatchFields() {
        let json = """
        { "type": "new", "request": {
            "id": "req-1", "code": "C", "agentId": "a", "tool": "t", "args": {}, "timeoutMs": 0,
            "batchId": "b1", "batchCode": "BATCH-1", "batchSize": 2, "escalated": true } }
        """
        guard case .newRequest(let request) = SSEMessage.parse(from: Data(json.utf8)) else {
            return XCTFail("Expected newRequest")
        }
        XCTAssertEqual(request.batchId, "b1")
        XCTAssertEqual(request.batchSize, 2)
        XCTAssertTrue(request.escalated)
    }

    func testSSEResolvedEventWithBatchFieldsStillParses() {
        let json = """
        { "type": "resolved", "id": "req-1", "code": "C", "action": "approved", "batchId": "b1", "batchPending": 1 }
        """
        guard case .resolved(let id, _, let action) = SSEMessage.parse(from: Data(json.utf8)) else {
            return XCTFail("Expected resolved")
        }
        XCTAssertEqual(id, "req-1")
        XCTAssertEqual(action, "approved")
    }

    // MARK: - Grouping

    func testGroupsByBatchThenAgentAndSkipsSingletons() {
        var b1 = ApprovalRequest(id: "1", code: "1", agentId: "a", tool: "t", args: [:], timeoutMs: 0)
        b1.batchId = "batch"
        b1.batchCode = "BATCH-1"
        var b2 = ApprovalRequest(id: "2", code: "2", agentId: "a", tool: "t", args: [:], timeoutMs: 0)
        b2.batchId = "batch"
        b2.batchCode = "BATCH-1"
        b2.escalated = true
        let lone = ApprovalRequest(id: "3", code: "3", agentId: "a", tool: "t", args: [:], timeoutMs: 0)
        let c1 = ApprovalRequest(id: "4", code: "4", agentId: "c", tool: "t", args: [:], timeoutMs: 0)
        let c2 = ApprovalRequest(id: "5", code: "5", agentId: "c", tool: "t", args: [:], timeoutMs: 0)

        let groups = ApprovalGroup.groups(from: [b1, lone, c1, b2, c2])

        XCTAssertEqual(groups.map(\.id), ["batch:batch", "agent:c"])
        XCTAssertEqual(groups[0].ids, ["1", "2"])
        XCTAssertEqual(groups[0].approvableIds, ["1"])
        XCTAssertEqual(groups[0].flaggedCount, 1)
        XCTAssertEqual(groups[0].title, "a · batch BATCH-1")
        XCTAssertEqual(groups[1].approvableIds, ["4", "5"])
    }

    // MARK: - Grants

    func testDecodesGrantList() throws {
        let json = """
        { "grants": [
            { "id": "g1", "agentId": "research", "scope": { "kind": "tier", "tier": "read", "provider": "gmail" },
              "source": "approval", "label": "read-only gmail tools for 1h",
              "createdAt": "2026-10-14T10:00:00.000Z", "expiresAt": "2026-10-14T11:00:00.000Z", "usesRemaining": 4 },
            { "id": "g2", "agentId": "coder", "scope": { "kind": "provider", "provider": "github" },
              "source": "operator", "createdAt": "2026-10-14T10:00:00Z" },
            { "id": "g3", "agentId": "coder", "scope": { "kind": "brand-new" }, "source": "future" }
        ] }
        """
        struct Wrapper: Decodable { let grants: [ApprovalGrant] }
        let grants = try JSONDecoder().decode(Wrapper.self, from: Data(json.utf8)).grants

        XCTAssertEqual(grants.count, 3)
        XCTAssertEqual(grants[0].scopeKind, "tier")
        XCTAssertEqual(grants[0].displayTitle, "read-only gmail tools for 1h")
        XCTAssertEqual(grants[0].usesRemaining, 4)
        let expiresAt = try XCTUnwrap(grants[0].expiresAt)
        XCTAssertEqual(
            grants[0].statusText(at: expiresAt.addingTimeInterval(-90 * 60 + 30 * 60)),
            "expires in 1h · 4 uses left"
        )
        XCTAssertTrue(grants[0].isExpired(at: expiresAt))
        XCTAssertEqual(grants[1].displayTitle, "All github tools")
        XCTAssertEqual(grants[1].statusText(), "until revoked")
        XCTAssertFalse(grants[1].isExpired())
        XCTAssertEqual(grants[2].displayTitle, "brand-new")
    }

    func testDecodesApproveOutcomeWithAutoApprovedIds() throws {
        let json = """
        { "ok": true, "approved": ["a", "b"], "grant": { "id": "g1", "agentId": "x", "scope": { "kind": "tool", "tool": "t" },
          "source": "approval", "createdAt": "2026-10-14T10:00:00Z" } }
        """
        let outcome = try JSONDecoder().decode(ApprovalDecisionOutcome.self, from: Data(json.utf8))
        XCTAssertEqual(outcome.approved, ["a", "b"])
        XCTAssertEqual(outcome.grant?.displayTitle, "t")
    }

    // MARK: - Request building

    func testDecisionRequestWithGrantOmitsLegacyRemember() throws {
        let client = AirlockAPIClient(baseURL: "http://127.0.0.1:4113", bearerToken: "token")
        let option = GrantOption(scope: "tier", label: "Allow read-only gmail tools", tier: "read")
        let request = try client.makeDecisionRequest(
            id: "req-1",
            decision: "approved",
            grant: option.spec(durationMs: GrantDuration.oneHour.milliseconds)
        )

        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(json["decision"] as? String, "approved")
        XCTAssertNil(json["remember"])
        XCTAssertNil(json["duration_ms"])
        let grant = try XCTUnwrap(json["grant"] as? [String: Any])
        XCTAssertEqual(grant["scope"] as? String, "tier")
        XCTAssertEqual(grant["tier"] as? String, "read")
        XCTAssertEqual(grant["duration_ms"] as? Int, 3_600_000)
        XCTAssertNil(grant["profile"])
    }

    func testTemporaryRememberAlsoSendsToolGrant() throws {
        let client = AirlockAPIClient(baseURL: "http://127.0.0.1:4113")
        let request = try client.makeDecisionRequest(
            id: "req-1", decision: "approved", remember: .temporary, durationMs: 900_000
        )

        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(json["remember"] as? String, "temporary")
        XCTAssertEqual(json["duration_ms"] as? Int, 900_000)
        let grant = try XCTUnwrap(json["grant"] as? [String: Any])
        XCTAssertEqual(grant["scope"] as? String, "tool")
        XCTAssertEqual(grant["duration_ms"] as? Int, 900_000)
    }

    func testAlwaysRememberAndDenyCarryNoGrant() throws {
        let client = AirlockAPIClient(baseURL: "http://127.0.0.1:4113")
        let always = try client.makeDecisionRequest(id: "r", decision: "approved", remember: .always)
        let deny = try client.makeDecisionRequest(id: "r", decision: "denied")

        let alwaysJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(always.httpBody)) as? [String: Any])
        XCTAssertEqual(alwaysJSON["remember"] as? String, "always")
        XCTAssertNil(alwaysJSON["grant"])
        let denyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(deny.httpBody)) as? [String: Any])
        XCTAssertEqual(denyJSON.keys.sorted(), ["decision"])
    }

    func testBulkBatchAndGrantRequests() throws {
        let client = AirlockAPIClient(baseURL: "http://127.0.0.1:4113/", bearerToken: "token")

        let bulk = try client.makeBulkDecisionRequest(ids: ["a", "b"], decision: "approved")
        XCTAssertEqual(bulk.httpMethod, "POST")
        XCTAssertEqual(bulk.url?.path, "/mobile/approvals/decisions")
        XCTAssertEqual(bulk.value(forHTTPHeaderField: "Authorization"), "Bearer token")
        let bulkJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(bulk.httpBody)) as? [String: Any])
        XCTAssertEqual(bulkJSON["ids"] as? [String], ["a", "b"])
        XCTAssertEqual(bulkJSON["decision"] as? String, "approved")
        XCTAssertNil(bulkJSON["reason"])

        let batch = try client.makeBatchDecisionRequest(batch: "BATCH-1", decision: "denied")
        XCTAssertEqual(batch.httpMethod, "POST")
        XCTAssertEqual(batch.url?.path, "/mobile/batches/BATCH-1/decision")
        let batchJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(batch.httpBody)) as? [String: Any])
        XCTAssertEqual(batchJSON.keys.sorted(), ["decision"])

        let list = try client.makeGrantsRequest()
        XCTAssertEqual(list.httpMethod, "GET")
        XCTAssertEqual(list.url?.path, "/mobile/grants")

        let revoke = try client.makeRevokeGrantRequest(id: "g1")
        XCTAssertEqual(revoke.httpMethod, "DELETE")
        XCTAssertEqual(revoke.url?.path, "/mobile/grants/g1")
        XCTAssertEqual(revoke.value(forHTTPHeaderField: "Authorization"), "Bearer token")
    }

    func testFormatRemaining() {
        XCTAssertEqual(ApprovalGrant.formatRemaining(-5), "0s")
        XCTAssertEqual(ApprovalGrant.formatRemaining(45), "45s")
        XCTAssertEqual(ApprovalGrant.formatRemaining(14 * 60 + 59), "14m")
        XCTAssertEqual(ApprovalGrant.formatRemaining(8 * 3600), "8h")
        XCTAssertEqual(ApprovalGrant.formatRemaining(3600 + 30 * 60), "1h 30m")
    }
}
