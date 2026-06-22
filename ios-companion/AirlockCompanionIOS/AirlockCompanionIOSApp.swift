import SwiftUI
import UIKit

@main
struct AirlockCompanionIOSApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var viewModel = AppViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(viewModel: viewModel)
                .onAppear { viewModel.start() }
                .onDisappear { viewModel.stop() }
                .onReceive(NotificationCenter.default.publisher(for: .airlockShouldRefresh)) { _ in
                    viewModel.refresh()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        viewModel.refresh()
                    }
                }
                .preferredColorScheme(viewModel.preferredColorScheme)
        }
    }
}

struct RootView: View {
    @ObservedObject var viewModel: AppViewModel

    var body: some View {
        TabView {
            NavigationStack {
                QueueView(viewModel: viewModel)
            }
            .tabItem {
                Label("Queue", systemImage: "checklist")
            }
            .badge(viewModel.activePendingCount)

            NavigationStack {
                HistoryView(viewModel: viewModel)
            }
            .tabItem {
                Label("History", systemImage: "clock.arrow.circlepath")
            }

            NavigationStack {
                SettingsView(viewModel: viewModel)
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape")
            }
        }
        .tint(.accentColor)
    }
}
