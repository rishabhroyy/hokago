import SwiftUI

@main
struct HokagoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        RootViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}