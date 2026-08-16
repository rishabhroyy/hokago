import Foundation
import UIKit
import WebKit

/// The native half of the bridge: builds the injected script, receives
/// messages from the web view, and posts events back into the page.
final class NativeBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    private lazy var downloadManager = DownloadManager()

    /// Build the `window.hokagoNative` shim with this build's versions baked
    /// in — the web app's MIN_NATIVE_VERSION gate reads them.
    func initializationScript() -> String {
        guard
            let path = Bundle.main.path(forResource: "injected", ofType: "js"),
            let template = try? String(contentsOfFile: path, encoding: .utf8)
        else { return "// missing injected.js" }

        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let serverUrl = ServerConfig.shared.serverURL?.absoluteString ?? ""
        return template
            .replacingOccurrences(of: "%CLIENT_KEY%", with: ServerConfig.shared.clientKey)
            .replacingOccurrences(of: "%APP_VERSION%", with: version)
            .replacingOccurrences(of: "%APP_BUILD%", with: build)
            .replacingOccurrences(of: "%SERVER_URL%", with: serverUrl)
    }

    // ── Inbound (web → native) ─────────────────────────────────────────────
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        guard let type = body["type"] as? String else { return }

        switch type {
        case "storageSet":
            if let key = body["key"] as? String, let value = body["value"] as? String {
                SecureStore.set(key, value)
            }
        case "storageDelete":
            if let key = body["key"] as? String {
                SecureStore.delete(key)
            }
        case "storageHydrate":
            hydrate()
        case "download":
            guard let id = body["id"] as? Int,
                  let url = body["url"] as? String,
                  let filename = body["filename"] as? String,
                  let urlObj = URL(string: url) else { return }
            downloadManager.save(url: urlObj, filename: filename) { [weak self] result in
                self?.post(event: "downloadResult", payload: [
                    "id": id,
                    "ok": result.ok,
                    "localPath": result.localPath ?? "",
                    "sizeBytes": result.sizeBytes ?? 0,
                    "error": result.error ?? "",
                ])
            }
        case "downloadList":
            guard let id = body["id"] as? Int else { return }
            let entries = downloadManager.list()
            post(event: "downloadListResult", payload: ["id": id, "entries": entries])
        case "readText":
            guard let id = body["id"] as? Int, let path = body["localPath"] as? String else { return }
            if let text = try? String(contentsOfFile: path, encoding: .utf8) {
                post(event: "readTextResult", payload: ["id": id, "ok": true, "text": text])
            } else {
                post(event: "readTextResult", payload: ["id": id, "ok": false, "error": "could not read subtitle"])
            }
        case "route":
            let view = body["view"] as? String ?? ""
            let inPlayer = (view == "player" || view == "offlineWatch")
            PlayerRouteState.shared.inPlayer = inPlayer
            rotateForPlayer(inPlayer)
        case "open":
            if let path = body["localPath"] as? String {
                let url = URL(fileURLWithPath: path)
                let interaction = UIDocumentInteractionController(url: url)
                // keep a strong ref while presenting from the root VC
                documentInteraction = interaction
                interaction.presentOptionsMenu(from: CGRect(x: 0, y: 0, width: 0, height: 0), in: webView ?? UIView(), animated: true)
            }
        default:
            break
        }
    }

    private var documentInteraction: UIDocumentInteractionController?

    /// Swing the device to landscape while watching and back to portrait
    /// after (iPads keep free rotation). The mask flip alone won't rotate a
    /// portrait-held phone — the UIDevice orientation kick is the same
    /// mechanism Plex/YouTube-style apps use; attemptRotation then re-applies
    /// the (possibly just-changed) supported mask cleanly.
    private func rotateForPlayer(_ inPlayer: Bool) {
        if UIDevice.current.userInterfaceIdiom == .pad { return }
        let target: UIInterfaceOrientation = inPlayer ? .landscapeLeft : .portrait
        UIDevice.current.setValue(target.rawValue, forKey: "orientation")
        UIViewController.attemptRotationToDeviceOrientation()
    }

    // ── Outbound (native → web) ────────────────────────────────────────────
    func post(event: String, payload: [String: Any]) {
        guard let webView else { return }
        var data = payload
        data["type"] = event
        guard let jsonData = try? JSONSerialization.data(withJSONObject: data),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return }
        let script = "window.dispatchEvent(new CustomEvent('hokago-native', { detail: \(jsonString) }));"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Re-seed localStorage from the secure store (webview storage wipe).
    /// Keychain entries can't be enumerated, so hydration is name-based —
    /// keep this list in sync with the web app's persisted keys (sessions,
    /// device id, theme, and the offline library manifest).
    private func hydrate() {
        let keys = [
            "hokago_access_token", "hokago_refresh_token", "hokago_device_id",
            "hokago_user_id", "hokago_username", "hokago_user_is_admin",
            "hokago_theme",
            "hokago_offline_library", "hokago_offline_watch_queue", "hokago_offline_viewed",
            "hokago_local_downloads", "hokago_tv_accounts", "hokago_tv_active",
        ]
        for key in keys {
            guard let value = SecureStore.get(key) else { continue }
            let escaped = value
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
            let script = "try { if (localStorage.getItem('\(key)') === null) localStorage.setItem('\(key)', '\(escaped)'); } catch (e) {}"
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}