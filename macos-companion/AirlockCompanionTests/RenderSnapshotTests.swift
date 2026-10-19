import SwiftUI
import XCTest
@testable import AirlockCompanion

/// Renders the approval views with live gateway data to PNGs for visual review. Skipped unless both
/// AIRLOCK_LIVE_URL and AIRLOCK_RENDER_DIR are set.
@MainActor
final class RenderSnapshotTests: XCTestCase {
    func testRenderApprovalViews() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["AIRLOCK_LIVE_URL"], let dir = env["AIRLOCK_RENDER_DIR"] else {
            throw XCTSkip("AIRLOCK_LIVE_URL / AIRLOCK_RENDER_DIR not set")
        }
        let client = AirlockAPIClient(baseURL: url, bearerToken: env["AIRLOCK_LIVE_TOKEN"])
        let pending = try await client.pendingApprovals()
        let grants = try await client.grants()

        let list = VStack(spacing: 8) {
            ForEach(ApprovalGroup.groups(from: pending)) { group in
                ApprovalGroupBar(group: group, onApproveAll: {}, onDenyAll: {})
            }
            ForEach(pending) { request in
                RequestCardView(request: request, onShowDetails: {}, onApprove: {}, onDeny: {}, onApproveWithGrant: { _ in })
            }
        }
        try await render(list, to: "\(dir)/mac-list.png")

        if let plan = pending.first(where: \.isPlan) {
            try await render(detail(plan), to: "\(dir)/mac-plan-detail.png", height: 520)
        }
        if let call = pending.first(where: { !$0.isPlan }) {
            try await render(detail(call), to: "\(dir)/mac-call-detail.png", height: 520)
        }
        try await render(ActiveGrantsView(grants: grants, isExpanded: .constant(true), onRevoke: { _ in }), to: "\(dir)/mac-grants.png")
    }

    private func detail(_ request: ApprovalRequest) -> some View {
        RequestDetailView(
            request: request,
            onApprove: {},
            onDeny: {},
            onApproveWithGrant: { _ in },
            onDismiss: {},
            argsScrollView: .constant(nil)
        )
    }

    /// Hosts the view in a real offscreen window so AppKit-backed controls (menus, scroll views)
    /// draw the same way they do on screen.
    private func render(_ view: some View, to path: String, height: CGFloat? = nil) async throws {
        let framed = view
            .padding(12)
            .frame(width: 380)
            .frame(height: height)
            .background(Color(nsColor: .windowBackgroundColor))
        let host = NSHostingView(rootView: framed)
        host.appearance = NSAppearance(named: .aqua)
        let size = NSSize(width: 380, height: height ?? host.fittingSize.height)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        host.frame = NSRect(origin: .zero, size: size)
        window.orderBack(nil)
        try await Task.sleep(for: .milliseconds(400))
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        window.orderOut(nil)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: path))
    }
}
