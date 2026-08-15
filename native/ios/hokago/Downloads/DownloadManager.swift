import Foundation

/// Native downloads: streams artifact URLs to Documents/hokago/, authenticating
/// with the Bearer token mirrored into the Keychain by the web app.
final class DownloadManager {
    struct Result {
        var ok: Bool
        var localPath: String?
        var sizeBytes: Int64?
        var error: String?
    }

    func save(url: URL, filename: String, completion: @escaping (Result) -> Void) {
        guard let token = SecureStore.get("hokago_access_token"), !token.isEmpty else {
            completion(Result(ok: false, error: "no session — sign in first"))
            return
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 3600

        let task = URLSession.shared.downloadTask(with: request) { [weak self] tempURL, response, error in
            guard let self else { return }
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    completion(self.result(error: "session expired — reopen hokago to refresh"))
                    return
                }
                if http.statusCode < 200 || http.statusCode >= 300 {
                    completion(self.result(error: "the server answered \(http.statusCode)"))
                    return
                }
            }
            if let error {
                completion(self.result(error: error.localizedDescription))
                return
            }
            guard let tempURL else {
                completion(self.result(error: "download failed"))
                return
            }
            completion(self.move(tempURL, filename: filename))
        }
        task.resume()
    }

    private func move(_ temp: URL, filename: String) -> Result {
        let dir = docsDirectory().appendingPathComponent("hokago", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let safe = filename
            .map { char -> Character in
                if char.isLetter || char.isNumber || char == "." || char == "-" || char == "_" || char == " " {
                    return char
                }
                return "_"
            }
        let dest = dir.appendingPathComponent(String(safe))
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.moveItem(at: temp, to: dest)
            let attrs = try FileManager.default.attributesOfItem(atPath: dest.path)
            let size = (attrs[.size] as? Int64) ?? 0
            return Result(ok: true, localPath: dest.path, sizeBytes: size)
        } catch {
            return result(error: error.localizedDescription)
        }
    }

    private func docsDirectory() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private func result(error: String) -> Result {
        Result(ok: false, error: error)
    }
}