import SwiftUI

/// Whether the web app is currently on a player route — the shell hides the
/// status bar and home indicator for a cinema-like watch (Netflix-style) and
/// restores them on exit. Driven by the web app's route events; old servers
/// that never dispatch them leave everything visible.
final class PlayerRouteState: ObservableObject {
    static let shared = PlayerRouteState()
    @Published var inPlayer = false
    private init() {}
}

@main
struct HokagoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var playerRoute = PlayerRouteState.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
                .statusBarHidden(playerRoute.inPlayer)
                .persistentSystemOverlays(playerRoute.inPlayer ? .hidden : .automatic)
        }
    }
}

struct RootView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        RootViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}