import AppKit
import Carbon
import SwiftUI

@MainActor
struct StatusItemPresentation {
    static let iconSize = NSSize(width: 18, height: 18)

    let label: String

    init(pendingCount: Int) {
        label = pendingCount > 9 ? "9+" : pendingCount > 0 ? "\(pendingCount)" : ""
    }

    var length: CGFloat {
        label.isEmpty ? NSStatusItem.squareLength : NSStatusItem.variableLength
    }

    var imagePosition: NSControl.ImagePosition {
        label.isEmpty ? .imageOnly : .imageLeading
    }

    static func configureIcon(on button: NSButton) {
        let config = NSImage.SymbolConfiguration(pointSize: iconSize.width, weight: .regular)
        let image = NSImage(systemSymbolName: "lock.shield", accessibilityDescription: "Airlock")?
            .withSymbolConfiguration(config)
        image?.size = iconSize
        button.image = image
        button.imageScaling = .scaleProportionallyDown
    }
}

@MainActor
final class StatusBarController {
    private var statusItem: NSStatusItem
    private var popover: NSPopover
    private weak var viewModel: AppViewModel?
    private var clickMonitor: Any?
    private var localKeyMonitor: Any?
    private var eventHandlerRef: EventHandlerRef?
    private var hotkeyRefs: [UInt32: EventHotKeyRef] = [:]

    init(viewModel: AppViewModel) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        popover = NSPopover()

        self.viewModel = viewModel
        let contentView = PopoverContentView(viewModel: viewModel) { [weak self] in
            self?.closePopover()
        }
        popover.contentSize = NSSize(width: Constants.popoverWidth, height: Constants.popoverMaxHeight)
        popover.behavior = .transient
        popover.animates = false
        popover.contentViewController = NSHostingController(rootView: contentView)

        viewModel.onSettingsChanged = { [weak self] in
            self?.registerHotkeys()
            self?.updatePopoverSize()
        }

        if let button = statusItem.button {
            StatusItemPresentation.configureIcon(on: button)
            button.action = #selector(togglePopover)
            button.target = self
        }

        // Close popover when clicking outside
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.closePopover()
        }

        // Local hotkey: Ctrl+Shift+A toggles the popover when the app is focused
        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let requiredFlags: NSEvent.ModifierFlags = [.control, .shift]
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags == requiredFlags && event.charactersIgnoringModifiers?.lowercased() == "a" {
                DispatchQueue.main.async { self?.togglePopover() }
                return nil
            }
            return event
        }

        installHotkeyHandler()
        registerGlobalHotkey()
    }

    // MARK: - Carbon Global Hotkey

    private enum HotkeyID {
        static let toggle: UInt32 = 1
        static let approve: UInt32 = 2
        static let deny: UInt32 = 3
    }

    private func installHotkeyHandler() {
        let refcon = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))

        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, refcon -> OSStatus in
                guard let event, let refcon else { return OSStatus(eventNotHandledErr) }

                var hotkeyID = EventHotKeyID()
                let status = GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotkeyID
                )
                guard status == noErr else { return status }

                let controller = Unmanaged<StatusBarController>.fromOpaque(refcon).takeUnretainedValue()
                DispatchQueue.main.async {
                    controller.handleHotkey(id: hotkeyID.id)
                }

                return noErr
            },
            1,
            &eventType,
            refcon,
            &eventHandlerRef
        )
    }

    private func updatePopoverSize() {
        guard let viewModel else { return }
        let density = viewModel.density
        popover.contentSize = NSSize(width: density.popoverWidth, height: density.popoverMaxHeight)
    }

    private func registerGlobalHotkey() {
        registerHotkeys()
    }

    private func registerHotkeys() {
        unregisterHotkeys()

        registerHotkey(id: HotkeyID.toggle, key: "A")
        registerHotkey(id: HotkeyID.approve, key: viewModel?.approveShortcutKey ?? "S")
        registerHotkey(id: HotkeyID.deny, key: viewModel?.denyShortcutKey ?? "D")
    }

    private func registerHotkey(id: UInt32, key: String) {
        guard let keyCode = Self.keyCode(for: key) else { return }

        let hotkeyID = EventHotKeyID(signature: OSType(0x414C4B), id: id)
        let modifiers: UInt32 = UInt32(controlKey | shiftKey)
        var hotkeyRef: EventHotKeyRef?

        let status = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotkeyID,
            GetApplicationEventTarget(),
            0,
            &hotkeyRef
        )

        if status == noErr, let hotkeyRef {
            hotkeyRefs[id] = hotkeyRef
        }
    }

    private func unregisterHotkeys() {
        for ref in hotkeyRefs.values {
            UnregisterEventHotKey(ref)
        }
        hotkeyRefs.removeAll()
    }

    private func handleHotkey(id: UInt32) {
        switch id {
        case HotkeyID.toggle:
            togglePopover()
        case HotkeyID.approve:
            viewModel?.approveSelectedRequest()
        case HotkeyID.deny:
            viewModel?.denySelectedRequest()
        default:
            break
        }
    }

    private static func keyCode(for key: String) -> UInt32? {
        switch key.uppercased() {
        case "A": UInt32(kVK_ANSI_A)
        case "B": UInt32(kVK_ANSI_B)
        case "C": UInt32(kVK_ANSI_C)
        case "D": UInt32(kVK_ANSI_D)
        case "E": UInt32(kVK_ANSI_E)
        case "F": UInt32(kVK_ANSI_F)
        case "G": UInt32(kVK_ANSI_G)
        case "H": UInt32(kVK_ANSI_H)
        case "I": UInt32(kVK_ANSI_I)
        case "J": UInt32(kVK_ANSI_J)
        case "K": UInt32(kVK_ANSI_K)
        case "L": UInt32(kVK_ANSI_L)
        case "M": UInt32(kVK_ANSI_M)
        case "N": UInt32(kVK_ANSI_N)
        case "O": UInt32(kVK_ANSI_O)
        case "P": UInt32(kVK_ANSI_P)
        case "Q": UInt32(kVK_ANSI_Q)
        case "R": UInt32(kVK_ANSI_R)
        case "S": UInt32(kVK_ANSI_S)
        case "T": UInt32(kVK_ANSI_T)
        case "U": UInt32(kVK_ANSI_U)
        case "V": UInt32(kVK_ANSI_V)
        case "W": UInt32(kVK_ANSI_W)
        case "X": UInt32(kVK_ANSI_X)
        case "Y": UInt32(kVK_ANSI_Y)
        case "Z": UInt32(kVK_ANSI_Z)
        default: nil
        }
    }

    deinit {
        MainActor.assumeIsolated {
            if let monitor = clickMonitor {
                NSEvent.removeMonitor(monitor)
            }
            if let monitor = localKeyMonitor {
                NSEvent.removeMonitor(monitor)
            }
            for ref in hotkeyRefs.values {
                UnregisterEventHotKey(ref)
            }
            if let eventHandlerRef {
                RemoveEventHandler(eventHandlerRef)
            }
        }
    }

    func updateBadge(count: Int) {
        let presentation = StatusItemPresentation(pendingCount: count)
        statusItem.length = presentation.length
        statusItem.button?.imagePosition = presentation.imagePosition
        statusItem.button?.attributedTitle = NSAttributedString(
            string: presentation.label,
            attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .bold),
                .foregroundColor: NSColor.systemRed,
            ]
        )
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
