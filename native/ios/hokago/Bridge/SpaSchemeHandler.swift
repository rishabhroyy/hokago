import Foundation
import WebKit

/// Serves the bundled SPA (web-dist, a copy of apps/web/dist) from
/// `hokago-spa://localhost/` — the offline fallback when the configured
/// server is unreachable. Loading through a scheme handler (rather than
/// file://) is what makes the SPA work: its asset URLs are absolute
/// (/assets/...), the history router needs a root path, and localStorage is
/// origin-scoped. Route fallback to index.html so SPA deep links work.
final class SpaSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == "hokago-spa",
              let root = Bundle.main.url(forResource: "web-dist", withExtension: nil) else {
            urlSchemeTask.didFailWithError(URLError(.unsupportedURL))
            return
        }

        var rel = url.path
        while rel.hasPrefix("/") { rel.removeFirst() }
        // Reject path traversal, then fall back to index.html for deep links.
        var fileURL = root
        var traversal = false
        for part in rel.split(separator: "/") {
            if part == ".." { traversal = true; break }
            fileURL.appendPathComponent(String(part))
        }
        if traversal || rel.isEmpty || !FileManager.default.fileExists(atPath: fileURL.path) || (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            fileURL = root.appendingPathComponent("index.html")
        }

        guard let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let headers: [String: String] = [
            "Content-Type": Self.mime(for: fileURL),
            "Content-Length": "\(data.count)",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        ]
        if let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) {
            urlSchemeTask.didReceive(response)
        }
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    static func mime(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "gif": return "image/gif"
        case "wasm": return "application/wasm"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "json", "map": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "ico": return "image/x-icon"
        case "txt", "vtt", "ass", "ssa", "srt": return "text/plain; charset=utf-8"
        case "mp4", "m4v": return "video/mp4"
        case "mkv": return "video/x-matroska"
        case "webm": return "video/webm"
        case "mov": return "video/quicktime"
        case "ts", "m2ts": return "video/mp2t"
        case "mp3": return "audio/mpeg"
        case "aac": return "audio/aac"
        case "flac": return "audio/flac"
        case "ogg", "opus": return "audio/ogg"
        default: return "application/octet-stream"
        }
    }
}
