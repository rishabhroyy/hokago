import Foundation
import UIKit
import WebKit

/// The WKWebView shell — plain browser engine, SPA loaded fresh from the
/// server on every launch (Discord-style: web UI is always current).
final class BrowserViewController: UIViewController, WKNavigationDelegate {
    var webView: WKWebView!
    private let serverURL: URL
    private let bridge: NativeBridge
    private var triedOfflineFallback = false

    init(serverURL: URL) {
        self.serverURL = serverURL
        self.bridge = NativeBridge()
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    override func loadView() {
        let script = bridge.initializationScript()
        let controller = WKUserContentController()
        controller.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )
        controller.add(bridge, name: "hokagoNative")

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(FileSchemeHandler(), forURLScheme: "hokago-file")
        config.setURLSchemeHandler(SpaSchemeHandler(), forURLScheme: "hokago-spa")
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // AirPlay rides along with the native client.
        config.allowsAirPlayForMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = true
        // The app is deliberately black — no white flash on load, and no
        // rubber-band gap showing anything but black when the page bounces.
        webView.backgroundColor = .black
        webView.underPageBackgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.bounces = false
        bridge.webView = webView
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        load(serverURL)
    }

    func load(_ url: URL) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        webView.load(request)
    }

    // ── Navigation ─────────────────────────────────────────────────────────
    func goBackOrNotify() {
        if webView.canGoBack {
            webView.goBack()
        } else {
            bridge.post(event: "back", payload: [:])
        }
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for press in presses where press.type == .menu {
            goBackOrNotify()
            return
        }
        super.pressesBegan(presses, with: event)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.code != -999 && !triedOfflineFallback {
            // Server unreachable — fall back to the bundled SPA (offline mode).
            triedOfflineFallback = true
            bridge.post(event: "loadError", payload: ["message": error.localizedDescription])
            loadBundledSpa()
        }
    }

    /// Offline fallback: the app bundles a copy of the SPA (web-dist) and
    /// serves it from hokago-spa://localhost/ (see SpaSchemeHandler) when the
    /// configured server can't be reached. loadHTMLString with that base URL
    /// gives the SPA a proper origin root — file:// breaks its absolute asset
    /// paths and history routing.
    func loadBundledSpa() {
        guard let bundleURL = Bundle.main.url(forResource: "web-dist", withExtension: nil),
              let html = try? String(contentsOf: bundleURL.appendingPathComponent("index.html"), encoding: .utf8) else { return }
        webView.loadHTMLString(html, baseURL: URL(string: "hokago-spa://localhost/"))
    }
}