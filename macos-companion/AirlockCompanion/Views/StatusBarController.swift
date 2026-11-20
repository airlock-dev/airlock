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

struct CompanionWindowLayout {
    static let minSize = NSSize(width: 340, height: 420)
    static let maxSize = NSSize(width: 1200, height: 1600)
    static let detailMinWidth: CGFloat = 620
    static let screenMargin: CGFloat = 8
    static let menuBarGap: CGFloat = 6

    static func clampedSize(_ size: NSSize, visibleFrame: NSRect? = nil) -> NSSize {
        let maxW: CGFloat
        let maxH: CGFloat
        if let visibleFrame {
            maxW = max(minSize.width, min(maxSize.width, visibleFrame.width - screenMargin * 2))
            maxH = max(minSize.height, min(maxSize.height, visibleFrame.height - menuBarGap - screenMargin))
        } else {
            maxW = maxSize.width
            maxH = maxSize.height
        }
        return NSSize(
            width: min(max(size.width, minSize.width), maxW).rounded(),
            height: min(max(size.height, minSize.height), maxH).rounded()
        )
    }

    static func preferredSize(density: DisplayDensity, defaults: UserDefaults = .standard) -> NSSize {
        let savedWidth = defaults.double(forKey: Constants.UserDefaultsKeys.companionWindowWidth)
        let savedHeight = defaults.double(forKey: Constants.UserDefaultsKeys.companionWindowHeight)
        let width = savedWidth > 0 ? CGFloat(savedWidth) : density.popoverWidth
        let height = savedHeight > 0 ? CGFloat(savedHeight) : density.popoverMaxHeight
        return clampedSize(NSSize(width: width, height: height))
    }

    static func saveSize(_ size: NSSize, defaults: UserDefaults = .standard) {
        let clamped = clampedSize(size)
        defaults.set(Double(clamped.width), forKey: Constants.UserDefaultsKeys.companionWindowWidth)
        defaults.set(Double(clamped.height), forKey: Constants.UserDefaultsKeys.companionWindowHeight)
    }

    static func clearSavedSize(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: Constants.UserDefaultsKeys.companionWindowWidth)
        defaults.removeObject(forKey: Constants.UserDefaultsKeys.companionWindowHeight)
    }

    static func anchoredFrame(
        size desiredSize: NSSize,
        anchorRect: NSRect?,
        visibleFrame: NSRect
    ) -> NSRect {
        let size = clampedSize(desiredSize, visibleFrame: visibleFrame)

        let rawX: CGFloat
        let topY: CGFloat
        if let anchorRect {
            rawX = anchorRect.midX - size.width / 2
            topY = min(anchorRect.minY, visibleFrame.maxY) - menuBarGap
        } else {
            rawX = visibleFrame.maxX - size.width - screenMargin
            topY = visibleFrame.maxY - menuBarGap
        }

        let minX = visibleFrame.minX + screenMargin
        let maxX = max(minX, visibleFrame.maxX - size.width - screenMargin)
        let x = min(max(rawX, minX), maxX)

        let minY = visibleFrame.minY + screenMargin
        let maxY = max(minY, visibleFrame.maxY - size.height - menuBarGap)
        let y = min(max(topY - size.height, minY), maxY)

        return NSRect(x: x.rounded(), y: y.rounded(), width: size.width, height: size.height)
    }

    static func resizedFrame(
        from currentFrame: NSRect,
        to desiredSize: NSSize,
        visibleFrame: NSRect?
    ) -> NSRect {
        let size = clampedSize(desiredSize, visibleFrame: visibleFrame)
        var x = currentFrame.midX - size.width / 2
        var y = currentFrame.maxY - size.height

        if let visibleFrame {
            let minX = visibleFrame.minX + screenMargin
            let maxX = max(minX, visibleFrame.maxX - size.width - screenMargin)
            x = min(max(x, minX), maxX)

            let minY = visibleFrame.minY + screenMargin
            let maxY = max(minY, visibleFrame.maxY - size.height - menuBarGap)
            y = min(max(y, minY), maxY)
        }

        return NSRect(x: x.rounded(), y: y.rounded(), width: size.width, height: size.height)
    }
}

private final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func zoom(_ sender: Any?) {}
}

@MainActor
final class StatusBarController: NSObject, NSWindowDelegate {
    private var statusItem: NSStatusItem
    private let panel: CompanionPanel
    private var hostingController: NSHostingController<PopoverContentView>?
    private weak var viewModel: AppViewModel?
    private var clickMonitor: Any?
    private var localKeyMonitor: Any?
    private var appResignObserver: NSObjectProtocol?
    private var eventHandlerRef: EventHandlerRef?
    private var hotkeyRefs: [UInt32: EventHotKeyRef] = [:]
    private var isProgrammaticResize = false
    private var lastAppliedDensity: DisplayDensity
    private var savedListWidthBeforeDetail: CGFloat?
    private var autoDetailWidth: CGFloat?

    init(viewModel: AppViewModel) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let initialDensity = viewModel.density
        lastAppliedDensity = initialDensity
        let initialSize = CompanionWindowLayout.preferredSize(density: initialDensity)

        panel = CompanionPanel(
            contentRect: NSRect(origin: .zero, size: initialSize),
            styleMask: [.titled, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        self.viewModel = viewModel

        super.init()

        configurePanel(initialSize: initialSize, viewModel: viewModel)

        viewModel.onSettingsChanged = { [weak self] in
            self?.registerHotkeys()
            self?.updatePanelSizeIfDensityChanged()
        }

        if let button = statusItem.button {
            StatusItemPresentation.configureIcon(on: button)
            button.action = #selector(togglePopover)
            button.target = self
        }

        // Close window when clicking outside
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.closePopover()
        }

        appResignObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.closePopover()
            }
        }

        // Local hotkey: Ctrl+Shift+A toggles the companion window when the app is focused
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

    private func configurePanel(initialSize: NSSize, viewModel: AppViewModel) {
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .statusBar
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.animationBehavior = .none

        for buttonType: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(buttonType)?.isHidden = true
        }

        let contentView = PopoverContentView(
            viewModel: viewModel,
            onOpenSettingsRequest: { [weak self] in
                self?.closePopover()
            },
            onDetailModeChanged: { [weak self] isDetail in
                self?.handleDetailModeChanged(isDetail)
            }
        )

        let visualEffect = NSVisualEffectView(frame: NSRect(origin: .zero, size: initialSize))
        visualEffect.material = .popover
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.autoresizingMask = [.width, .height]

        let hosting = NSHostingController(rootView: contentView)
        hosting.sizingOptions = []
        hosting.safeAreaRegions = []
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        hostingController = hosting

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
        performProgrammaticResize {
            panel.setContentSize(initialSize)
        }
        panel.delegate = self
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

    private func performProgrammaticResize(_ body: () -> Void) {
        isProgrammaticResize = true
        defer { isProgrammaticResize = false }
        body()
    }

    private func currentDesiredSize() -> NSSize {
        let density = viewModel?.density ?? .compact
        var size = CompanionWindowLayout.preferredSize(density: density)
        if let autoDetailWidth {
            size.width = max(size.width, autoDetailWidth)
        }
        return size
    }

    private func updatePanelSizeIfDensityChanged() {
        guard let viewModel else { return }
        let density = viewModel.density
        guard density != lastAppliedDensity else { return }
        lastAppliedDensity = density

        CompanionWindowLayout.clearSavedSize()
        savedListWidthBeforeDetail = nil
        autoDetailWidth = nil

        let targetSize = NSSize(width: density.popoverWidth, height: density.popoverMaxHeight)
        let visibleFrame = panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame
        let newFrame = CompanionWindowLayout.resizedFrame(
            from: panel.frame,
            to: targetSize,
            visibleFrame: visibleFrame
        )
        performProgrammaticResize {
            panel.setFrame(newFrame, display: true)
        }
    }

    private func handleDetailModeChanged(_ isDetail: Bool) {
        let visibleFrame = panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame
        let currentFrame = panel.frame

        if isDetail {
            if currentFrame.width < CompanionWindowLayout.detailMinWidth {
                savedListWidthBeforeDetail = currentFrame.width
                let newSize = NSSize(width: CompanionWindowLayout.detailMinWidth, height: currentFrame.height)
                let newFrame = CompanionWindowLayout.resizedFrame(
                    from: currentFrame,
                    to: newSize,
                    visibleFrame: visibleFrame
                )
                autoDetailWidth = newFrame.width
                performProgrammaticResize {
                    panel.setFrame(newFrame, display: true)
                }
            } else {
                savedListWidthBeforeDetail = nil
                autoDetailWidth = nil
            }
        } else {
            if let restoreWidth = savedListWidthBeforeDetail {
                let newSize = NSSize(width: restoreWidth, height: currentFrame.height)
                let newFrame = CompanionWindowLayout.resizedFrame(
                    from: currentFrame,
                    to: newSize,
                    visibleFrame: visibleFrame
                )
                savedListWidthBeforeDetail = nil
                autoDetailWidth = nil
                performProgrammaticResize {
                    panel.setFrame(newFrame, display: true)
                }
            } else {
                autoDetailWidth = nil
            }
        }
    }

    // MARK: - NSWindowDelegate

    func windowDidResize(_ notification: Notification) {
        guard !isProgrammaticResize, panel.isVisible else { return }
        let newSize = panel.frame.size

        if let savedListWidth = savedListWidthBeforeDetail,
           let autoWidth = autoDetailWidth,
           abs(newSize.width - autoWidth) < 1.0 {
            CompanionWindowLayout.saveSize(NSSize(width: savedListWidth, height: newSize.height))
        } else {
            savedListWidthBeforeDetail = nil
            autoDetailWidth = nil
            CompanionWindowLayout.saveSize(newSize)
        }
    }

    func windowShouldZoom(_ window: NSWindow, toFrame newFrame: NSRect) -> Bool {
        false
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
            if let observer = appResignObserver {
                NotificationCenter.default.removeObserver(observer)
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
        if panel.isVisible {
            closePopover()
        } else {
            showPopover()
        }
    }

    private func showPopover() {
        guard let button = statusItem.button else { return }
        viewModel?.selectedIndex = 0

        let targetSize = currentDesiredSize()
        let screen = button.window?.screen ?? NSScreen.main ?? NSScreen.screens.first
        let visibleFrame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let anchorRect = button.window.map { window in
            window.convertToScreen(button.convert(button.bounds, to: nil))
        }

        let frame = CompanionWindowLayout.anchoredFrame(
            size: targetSize,
            anchorRect: anchorRect,
            visibleFrame: visibleFrame
        )
        performProgrammaticResize {
            panel.setFrame(frame, display: true)
        }

        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        if let hostingView = hostingController?.view {
            panel.makeFirstResponder(hostingView)
        }
    }

    private func closePopover() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
    }
}
