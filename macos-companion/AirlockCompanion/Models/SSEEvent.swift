import Foundation

enum SSEMessage: Sendable {
    case newRequest(ApprovalRequest)
    case notifyEvent(ApprovalRequest)
    case resolved(code: String, action: String)

    static func parse(from data: Data) -> SSEMessage? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else {
            return nil
        }

        switch type {
        case "new":
            guard let requestDict = json["request"],
                  let requestData = try? JSONSerialization.data(withJSONObject: requestDict),
                  let request = try? JSONDecoder().decode(ApprovalRequest.self, from: requestData)
            else {
                return nil
            }
            return .newRequest(request)

        case "notify":
            guard let requestDict = json["request"],
                  let requestData = try? JSONSerialization.data(withJSONObject: requestDict),
                  let request = try? JSONDecoder().decode(ApprovalRequest.self, from: requestData)
            else {
                return nil
            }
            return .notifyEvent(request)

        case "resolved":
            guard let code = json["code"] as? String,
                  let action = json["action"] as? String
            else {
                return nil
            }
            return .resolved(code: code, action: action)

        default:
            return nil
        }
    }
}
