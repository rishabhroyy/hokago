import Foundation

/// Per-install state: server URL + a stable per-device client key.
final class ServerConfig {
    static let shared = ServerConfig()

    private let defaults = UserDefaults.standard
    private let urlKey = "serverURL"
    private let clientKeyKey = "clientKey"

    private(set) var clientKey: String

    init() {
        if let existing = defaults.string(forKey: clientKeyKey), !existing.isEmpty {
            clientKey = existing
        } else {
            clientKey = UUID().uuidString.lowercased()
            defaults.set(clientKey, forKey: clientKeyKey)
        }
    }

    var serverURL: URL? {
        get { defaults.url(forKey: urlKey) }
        set { newValue == nil ? defaults.removeObject(forKey: urlKey) : defaults.set(newValue, forKey: urlKey) }
    }
}

/// Secure storage mirror — tokens live in the Keychain, so clearing the
/// webview's WKWebsiteDataStore never kills a session.
final class SecureStore {
    private static let service = "com.hokago.app"

    static func get(_ key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ key: String, _ value: String) {
        let data = Data(value.utf8)
        var query = baseQuery(key)
        let attrs: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
            SecItemAdd(query as CFDictionary, nil)
        }
    }

    static func delete(_ key: String) {
        SecItemDelete(baseQuery(key) as CFDictionary)
    }

    private static func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}