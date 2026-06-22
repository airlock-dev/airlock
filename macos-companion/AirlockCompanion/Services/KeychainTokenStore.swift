import Foundation
import Security

struct KeychainTokenStore {
    private let service = "dev.airlock.companion"
    private let account = "gatewayBearerToken"

    func load() throws -> String {
        var query = baseQuery
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return ""
        }
        guard status == errSecSuccess else {
            throw KeychainTokenStoreError(status: status)
        }
        guard let data = result as? Data,
              let token = String(data: data, encoding: .utf8)
        else {
            return ""
        }
        return token
    }

    func save(_ token: String) throws {
        if token.isEmpty {
            try delete()
            return
        }

        let data = Data(token.utf8)
        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecSuccess {
            return
        }
        if status == errSecDuplicateItem {
            try update(data)
            return
        }
        throw KeychainTokenStoreError(status: status)
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainTokenStoreError(status: status)
        }
    }

    private func update(_ data: Data) throws {
        let attributes = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        guard status == errSecSuccess else {
            throw KeychainTokenStoreError(status: status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

struct KeychainTokenStoreError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? {
        if let message = SecCopyErrorMessageString(status, nil) as String? {
            return message
        }
        return "Keychain error \(status)"
    }
}
