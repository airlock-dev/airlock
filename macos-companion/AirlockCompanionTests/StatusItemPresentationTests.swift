import AppKit
import XCTest
@testable import AirlockCompanion

@MainActor
final class StatusItemPresentationTests: XCTestCase {
    func testIconUsesNativeMenuBarDimensionsWithoutUpscaling() throws {
        let button = NSButton()

        StatusItemPresentation.configureIcon(on: button)

        XCTAssertEqual(try XCTUnwrap(button.image).size, NSSize(width: 18, height: 18))
        XCTAssertEqual(button.imageScaling, .scaleProportionallyDown)
    }

    func testEmptyBadgeUsesSquareImageOnlyStatusItem() {
        let presentation = StatusItemPresentation(pendingCount: 0)

        XCTAssertEqual(presentation.label, "")
        XCTAssertEqual(presentation.length, NSStatusItem.squareLength)
        XCTAssertEqual(presentation.imagePosition, .imageOnly)
    }

    func testPendingBadgeExpandsStatusItemAndCapsLabel() {
        let presentation = StatusItemPresentation(pendingCount: 12)

        XCTAssertEqual(presentation.label, "9+")
        XCTAssertEqual(presentation.length, NSStatusItem.variableLength)
        XCTAssertEqual(presentation.imagePosition, .imageLeading)
    }
}
