import AppKit
import Carbon
import SwiftUI

@MainActor
final class StatusBarController {
    private var statusItem: NSStatusItem
    private var popover: NSPopover
    private weak var viewModel: AppViewModel?
    private var badgeView: NSView?
    private var badgeLabel: NSTextField?
    private var clickMonitor: Any?
    private var localKeyMonitor: Any?
    private var hotkeyRef: EventHotKeyRef?

    init(viewModel: AppViewModel) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        popover = NSPopover()

        self.viewModel = viewModel
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
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.closePopover()
        }

        // Local hotkey: Ctrl+Shift+A closes popover when it's focused
        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let requiredFlags: NSEvent.ModifierFlags = [.control, .shift]
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags == requiredFlags && event.charactersIgnoringModifiers?.lowercased() == "a" {
                DispatchQueue.main.async { self?.togglePopover() }
                return nil
            }
            return event
        }

        // Global hotkey via Carbon RegisterEventHotKey (Ctrl+Shift+A)
        registerGlobalHotkey()
    }

    // MARK: - Carbon Global Hotkey

    private func registerGlobalHotkey() {
        // Store a pointer to self for the C callback
        let refcon = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())

        // Install handler for hotkey events
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, event, refcon) -> OSStatus in
                guard let refcon else { return OSStatus(eventNotHandledErr) }
                let controller = Unmanaged<StatusBarController>.fromOpaque(refcon).takeUnretainedValue()
                DispatchQueue.main.async {
                    controller.togglePopover()
                }
                return noErr
            },
            1,
            &eventType,
            refcon,
            nil
        )

        // Register Ctrl+Shift+A: keycode 0 = 'a', modifiers = control + shift
        let hotkeyID = EventHotKeyID(signature: OSType(0x414C4B), id: 1) // "ALK" + 1
        let modifiers: UInt32 = UInt32(controlKey | shiftKey)
        RegisterEventHotKey(
            UInt32(kVK_ANSI_A),
            modifiers,
            hotkeyID,
            GetApplicationEventTarget(),
            0,
            &hotkeyRef
        )
    }

    deinit {
        if let monitor = clickMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let monitor = localKeyMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let ref = hotkeyRef {
            UnregisterEventHotKey(ref)
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
            viewModel?.selectedIndex = 0

            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)

            // Ensure popover window is key so .onKeyPress works
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func closePopover() {
        popover.performClose(nil)
    }
}
