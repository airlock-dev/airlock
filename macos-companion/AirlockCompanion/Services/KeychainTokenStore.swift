import Foundation
import Security

struct KeychainTokenStore {
    static let service = "bot.airlock.companion"
    static let account = "managementApiSecret"
    static let legacyItems = [
        Item(service: "dev.airlock.companion", account: "gatewayBearerToken"),
        Item(service: "com.airlock.companion", account: "gatewayBearerToken"),
        Item(service: "bot.airlock.companion", account: "gatewayBearerToken")
    ]

    private let primaryItem = Item(service: service, account: account)

    func load() throws -> String {
        var firstError: KeychainTokenStoreError?

        for item in allItems {
            let token: String
            do {
                token = try load(item)
            } catch let error as KeychainTokenStoreError {
                if firstError == nil {
                    firstError = error
                }
                continue
            }
            guard !token.isEmpty else { continue }

            if item != primaryItem {
                try? save(token)
            }
            return token
        }

        if let firstError {
            throw firstError
        }
        return ""
    }

    func save(_ token: String) throws {
        if token.isEmpty {
            try delete()
            return
        }

        let data = Data(token.utf8)
        var addQuery = baseQuery(for: primaryItem)
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
        for item in allItems {
            let status = SecItemDelete(baseQuery(for: item) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw KeychainTokenStoreError(status: status)
            }
        }
    }

    private func update(_ data: Data) throws {
        let attributes = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery(for: primaryItem) as CFDictionary, attributes as CFDictionary)
        guard status == errSecSuccess else {
            throw KeychainTokenStoreError(status: status)
        }
    }

    private func load(_ item: Item) throws -> String {
        var query = baseQuery(for: item)
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

    private var allItems: [Item] {
        [primaryItem] + Self.legacyItems.filter { $0 != primaryItem }
    }

    private func baseQuery(for item: Item) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: item.service,
            kSecAttrAccount as String: item.account,
        ]
    }

    struct Item: Equatable {
        let service: String
        let account: String
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
