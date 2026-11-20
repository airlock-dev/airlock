import AppKit
import SwiftUI
import XCTest
@testable import AirlockCompanion

@MainActor
final class CompanionWindowLayoutTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "CompanionWindowLayoutTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testPreferredSizeFallsBackToTallerDensityDefaults() {
        XCTAssertEqual(
            CompanionWindowLayout.preferredSize(density: .compact, defaults: defaults),
            NSSize(width: 360, height: 640)
        )
        XCTAssertEqual(
            CompanionWindowLayout.preferredSize(density: .comfortable, defaults: defaults),
            NSSize(width: 480, height: 760)
        )
        XCTAssertEqual(
            CompanionWindowLayout.preferredSize(density: .decadent, defaults: defaults),
            NSSize(width: 640, height: 900)
        )
    }

    func testSavedSizePersistsOverridesDensityAndClearsCleanly() {
        CompanionWindowLayout.saveSize(NSSize(width: 512, height: 820), defaults: defaults)

        XCTAssertEqual(
            CompanionWindowLayout.preferredSize(density: .compact, defaults: defaults),
            NSSize(width: 512, height: 820)
        )

        CompanionWindowLayout.clearSavedSize(defaults: defaults)
        XCTAssertEqual(
            CompanionWindowLayout.preferredSize(density: .compact, defaults: defaults),
            NSSize(width: 360, height: 640)
        )
    }

    func testClampedSizeRespectsMinMaxAndVisibleScreenBounds() {
        let tooSmall = CompanionWindowLayout.clampedSize(NSSize(width: 100, height: 150))
        XCTAssertEqual(tooSmall, CompanionWindowLayout.minSize)

        let tooLarge = CompanionWindowLayout.clampedSize(NSSize(width: 5000, height: 5000))
        XCTAssertEqual(tooLarge, CompanionWindowLayout.maxSize)

        let laptopVisible = NSRect(x: 0, y: 40, width: 1280, height: 740)
        let clampedToScreen = CompanionWindowLayout.clampedSize(
            NSSize(width: 640, height: 900),
            visibleFrame: laptopVisible
        )
        XCTAssertEqual(clampedToScreen.width, 640)
        XCTAssertEqual(
            clampedToScreen.height,
            laptopVisible.height - CompanionWindowLayout.menuBarGap - CompanionWindowLayout.screenMargin
        )
    }

    func testAnchoredFrameCentersUnderStatusButtonAndClampsToRightEdge() {
        let visible = NSRect(x: 0, y: 40, width: 1440, height: 835)
        let statusButtonNearRight = NSRect(x: 1380, y: 875, width: 28, height: 25)

        let frame = CompanionWindowLayout.anchoredFrame(
            size: NSSize(width: 400, height: 640),
            anchorRect: statusButtonNearRight,
            visibleFrame: visible
        )

        XCTAssertEqual(frame.width, 400)
        XCTAssertEqual(frame.height, 640)
        XCTAssertEqual(frame.maxX, visible.maxX - CompanionWindowLayout.screenMargin)
        XCTAssertEqual(frame.maxY, visible.maxY - CompanionWindowLayout.menuBarGap)
        XCTAssertGreaterThanOrEqual(frame.minY, visible.minY + CompanionWindowLayout.screenMargin)
    }

    func testAnchoredFrameCentersWhenSpaceAvailable() {
        let visible = NSRect(x: 0, y: 40, width: 1440, height: 835)
        let centeredButton = NSRect(x: 700, y: 875, width: 28, height: 25)

        let frame = CompanionWindowLayout.anchoredFrame(
            size: NSSize(width: 360, height: 640),
            anchorRect: centeredButton,
            visibleFrame: visible
        )

        XCTAssertEqual(frame.midX, centeredButton.midX, accuracy: 1.0)
        XCTAssertEqual(frame.maxY, visible.maxY - CompanionWindowLayout.menuBarGap)
    }

    func testAnchoredFrameWithoutAnchorPlacesTopRightOfVisibleScreen() {
        let visible = NSRect(x: 0, y: 40, width: 1440, height: 835)

        let frame = CompanionWindowLayout.anchoredFrame(
            size: NSSize(width: 360, height: 640),
            anchorRect: nil,
            visibleFrame: visible
        )

        XCTAssertEqual(frame.maxX, visible.maxX - CompanionWindowLayout.screenMargin)
        XCTAssertEqual(frame.maxY, visible.maxY - CompanionWindowLayout.menuBarGap)
    }

    func testResizedFramePinsTopEdgeAndStaysOnScreenWhenWideningForDetail() {
        let visible = NSRect(x: 0, y: 40, width: 1440, height: 835)
        let listFrame = NSRect(x: 1072, y: 229, width: 360, height: 640)

        let detailFrame = CompanionWindowLayout.resizedFrame(
            from: listFrame,
            to: NSSize(width: CompanionWindowLayout.detailMinWidth, height: listFrame.height),
            visibleFrame: visible
        )

        XCTAssertEqual(detailFrame.width, CompanionWindowLayout.detailMinWidth)
        XCTAssertEqual(detailFrame.height, listFrame.height)
        XCTAssertEqual(detailFrame.maxY, listFrame.maxY)
        XCTAssertLessThanOrEqual(detailFrame.maxX, visible.maxX - CompanionWindowLayout.screenMargin)
        XCTAssertGreaterThanOrEqual(detailFrame.minX, visible.minX + CompanionWindowLayout.screenMargin)
    }

    func testHostingControllerFillsResizablePanelAcrossSizeChanges() {
        let viewModel = AppViewModel()
        let contentView = PopoverContentView(viewModel: viewModel, onOpenSettingsRequest: {})
        let initialSize = NSSize(width: 360, height: 640)

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: initialSize),
            styleMask: [.titled, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true

        let visualEffect = NSVisualEffectView(frame: NSRect(origin: .zero, size: initialSize))
        visualEffect.autoresizingMask = [.width, .height]

        let hosting = NSHostingController(rootView: contentView)
        hosting.sizingOptions = []
        hosting.safeAreaRegions = []
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        visualEffect.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: visualEffect.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: visualEffect.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: visualEffect.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: visualEffect.bottomAnchor),
        ])

        let containerVC = NSViewController()
        containerVC.view = visualEffect
        containerVC.addChild(hosting)
        panel.contentViewController = containerVC
        panel.contentMinSize = CompanionWindowLayout.minSize
        panel.contentMaxSize = CompanionWindowLayout.maxSize
        panel.setContentSize(initialSize)
        panel.layoutIfNeeded()

        XCTAssertTrue(panel.styleMask.contains(.resizable))
        XCTAssertEqual(hosting.view.bounds.size, initialSize)

        let resizedSize = NSSize(width: 520, height: 840)
        panel.setContentSize(resizedSize)
        panel.layoutIfNeeded()

        XCTAssertEqual(hosting.view.bounds.size, resizedSize)

        // Verify the top-right header area (where the settings gear button lives)
        // is reachable via hit-testing and not blocked by the transparent titlebar.
        if let themeFrame = panel.contentView?.superview {
            let gearPoint = NSPoint(x: resizedSize.width - 22, y: resizedSize.height - 18)
            let hitView = themeFrame.hitTest(gearPoint)
            XCTAssertNotNil(hitView)
            XCTAssertTrue(hitView === hosting.view || (hitView?.isDescendant(of: hosting.view) ?? false))
        }
    }
}
