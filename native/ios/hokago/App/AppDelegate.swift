import UIKit

final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    /// Orientation policy (Plex-style): portrait everywhere, landscape while
    /// the SPA is on a player route — driven by the route event
    /// (PlayerRouteState). iPads keep free rotation on both sides.
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        let pad = UIDevice.current.userInterfaceIdiom == .pad
        if PlayerRouteState.shared.inPlayer {
            return pad ? .all : .landscape
        }
        return pad ? .all : .portrait
    }
}