import Foundation

enum SSEMessage: Sendable {
    case newRequest(ApprovalRequest)
    case resolved(id: String, code: String?, action: String)
    case activity(ActivityEvent)

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

        case "resolved":
            guard let id = json["id"] as? String,
                  let action = json["action"] as? String
            else {
                return nil
            }
            return .resolved(id: id, code: json["code"] as? String, action: action)

        case "activity":
            guard let eventDict = json["event"],
                  let eventData = try? JSONSerialization.data(withJSONObject: eventDict),
                  let event = try? JSONDecoder().decode(ActivityEvent.self, from: eventData)
            else {
                return nil
            }
            return .activity(event)

        default:
            return nil
        }
    }
}
