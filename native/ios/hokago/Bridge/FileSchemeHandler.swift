import Foundation
import WebKit

/// Serves `hokago-file://<encoded-path>` bytes to the webview — the offline
/// player's <video> source. The path is URL-encoded (the injected script
/// encodes it); Range support keeps seeking working.
final class FileSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == "hokago-file" else {
            urlSchemeTask.didFailWithError(URLError(.unsupportedURL))
            return
        }
        // URL is hokago-file://<absolute-path>; url.path yields the path with
        // %20 decoded to spaces.
        let path = url.path
        guard FileManager.default.fileExists(atPath: path) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let fileURL = URL(fileURLWithPath: path)

        let len = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? Int64) ?? 0
        let start: Int64
        let end: Int64
        var statusCode = 200

        if let range = urlSchemeTask.request.value(forHTTPHeaderField: "Range"),
           range.hasPrefix("bytes=") {
            let comps = range.dropFirst(6).split(separator: "-")
            start = comps.first.flatMap { Int64($0) } ?? 0
            end = comps.count > 1 ? (Int64(comps[1]) ?? len - 1) : len - 1
            statusCode = 206
        } else {
            start = 0
            end = len - 1
        }
        let clampedEnd = min(max(end, 0), len - 1)
        let count = clampedEnd >= start ? clampedEnd - start + 1 : 0

        guard let handle = try? FileHandle(forReadingFrom: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.cannotOpenFile))
            return
        }
        try? handle.seek(toOffset: UInt64(start))
        let data = handle.readData(ofLength: Int(count))
        try? handle.close()

        var headers: [String: String] = [
            "Content-Type": SpaSchemeHandler.mime(for: fileURL),
            "Content-Length": "\(data.count)",
            "Accept-Ranges": "bytes",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "no-store",
        ]
        if statusCode == 206 {
            headers["Content-Range"] = "bytes \(start)-\(clampedEnd)/\(len)"
        }
        if let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: headers) {
            urlSchemeTask.didReceive(response)
        }
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
