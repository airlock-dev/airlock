import SwiftUI
import AppKit
import Combine

@main
struct AirlockCompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            SettingsView(viewModel: AppDelegate.sharedViewModel)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static let sharedViewModel = AppViewModel()

    private var statusBarController: StatusBarController?
    private var badgeCancellable: AnyCancellable?
    private let viewModel = AppDelegate.sharedViewModel

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Warm up highlight.js on a background thread
        EmbeddedHighlighter.warmUp()

        // Set the app icon explicitly so notifications pick it up
        if let iconPath = Bundle.main.path(forResource: "AppIcon", ofType: "icns"),
           let icon = NSImage(contentsOfFile: iconPath) {
            NSApp.applicationIconImage = icon
        }

        // Hide dock icon
        NSApp.setActivationPolicy(.accessory)

        // Set up status bar
        statusBarController = StatusBarController(viewModel: viewModel)

        // Start SSE connection
        viewModel.start()

        // Observe pending count changes to update badge
        badgeCancellable = viewModel.$pendingRequests
            .map(\.count)
            .removeDuplicates()
            .sink { [weak self] count in
                self?.statusBarController?.updateBadge(count: count)
            }
    }

    func applicationWillTerminate(_ notification: Notification) {
        badgeCancellable?.cancel()
        viewModel.stop()
    }
}
