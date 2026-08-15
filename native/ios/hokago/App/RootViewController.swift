import UIKit
import WebKit

/// Root controller: shows the web view when a server URL is configured,
/// otherwise the first-run setup screen.
final class RootViewController: UIViewController {
    var webView: WebViewController?
    var setup: ServerSetupViewController?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let url = ServerConfig.shared.serverURL
        if let url {
            showWeb(at: url)
        } else {
            showSetup()
        }
    }

    func showSetup() {
        let vc = ServerSetupViewController()
        vc.onConnect = { [weak self] url in
            ServerConfig.shared.serverURL = url
            self?.showWeb(at: url)
        }
        addChild(vc)
        view.addSubview(vc.view)
        vc.view.frame = view.bounds
        vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        vc.didMove(toParent: self)
        setup = vc
    }

    func showWeb(at url: URL) {
        setup?.removeFromParent()
        setup?.view.removeFromSuperview()
        setup = nil
        let wv = WebViewController(serverURL: url)
        addChild(wv)
        view.addSubview(wv.view)
        wv.view.frame = view.bounds
        wv.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        wv.didMove(toParent: self)
        webView = wv
    }
}