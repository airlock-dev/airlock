import AppKit
import SwiftUI

@MainActor
final class StatusBarController {
    private var statusItem: NSStatusItem
    private var popover: NSPopover
    private var badgeView: NSView?
    private var badgeLabel: NSTextField?
    private var eventMonitor: Any?

    init(viewModel: AppViewModel) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        popover = NSPopover()

        let contentView = PopoverContentView(viewModel: viewModel)
        popover.contentSize = NSSize(width: Constants.popoverWidth, height: Constants.popoverMaxHeight)
        popover.behavior = .transient
        popover.animates = true
        popover.contentViewController = NSHostingController(rootView: contentView)

        if let button = statusItem.button {
            // Size the SF Symbol to fill the menu bar slot
            let config = NSImage.SymbolConfiguration(pointSize: 18, weight: .regular)
            let image = NSImage(systemSymbolName: "lock.shield", accessibilityDescription: "Airlock")?
                .withSymbolConfiguration(config)
            button.image = image
            button.imageScaling = .scaleProportionallyUpOrDown
            button.action = #selector(togglePopover)
            button.target = self

            // Create badge view — positioned to avoid clipping at edges
            let badgeSize: CGFloat = 14
            let badge = NSView(frame: NSRect(x: 12, y: 10, width: badgeSize, height: badgeSize))
            badge.wantsLayer = true
            badge.layer?.backgroundColor = NSColor.systemRed.cgColor
            badge.layer?.cornerRadius = badgeSize / 2
            badge.isHidden = true

            let label = NSTextField(labelWithString: "0")
            label.font = NSFont.systemFont(ofSize: 8, weight: .bold)
            label.textColor = .white
            label.alignment = .center
            label.frame = NSRect(x: 0, y: -0.5, width: badgeSize, height: badgeSize)
            badge.addSubview(label)

            button.addSubview(badge)
            badgeView = badge
            badgeLabel = label
        }

        // Close popover when clicking outside
        eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.closePopover()
        }
    }

    deinit {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    func updateBadge(count: Int) {
        badgeView?.isHidden = count == 0
        badgeLabel?.stringValue = count > 9 ? "9+" : "\(count)"
    }

    @objc private func togglePopover() {
        if popover.isShown {
            closePopover()
        } else {
            showPopover()
        }
    }

    private func showPopover() {
        if let button = statusItem.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)

            // Ensure popover window is key
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func closePopover() {
        popover.performClose(nil)
    }
}
