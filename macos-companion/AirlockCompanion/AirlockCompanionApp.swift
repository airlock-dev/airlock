import SwiftUI
import AppKit

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
    private let viewModel = AppDelegate.sharedViewModel

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        Task {
            var previousCount = 0
            while !Task.isCancelled {
                let count = viewModel.pendingCount
                if count != previousCount {
                    statusBarController?.updateBadge(count: count)
                    previousCount = count
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        viewModel.stop()
    }
}
