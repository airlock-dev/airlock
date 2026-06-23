import UIKit
import UserNotifications
import UserNotificationsUI
import os

@objc(NotificationViewController)
final class NotificationViewController: UIViewController, UNNotificationContentExtension {
    private let logger = Logger(subsystem: "bot.airlock.companion.NotificationContent", category: "NotificationContent")
    private let rootStack = UIStackView()
    private let titleLabel = UILabel()
    private let metaLabel = UILabel()
    private let timeoutLabel = UILabel()
    private let sectionLabel = UILabel()
    private let argsStack = UIStackView()

    private let background = UIColor(red: 0.10, green: 0.105, blue: 0.115, alpha: 1.0)
    private let panel = UIColor(red: 0.13, green: 0.135, blue: 0.15, alpha: 1.0)
    private let primaryText = UIColor(white: 0.96, alpha: 1.0)
    private let secondaryText = UIColor(white: 0.68, alpha: 1.0)
    private let accent = UIColor(red: 0.06, green: 0.58, blue: 0.94, alpha: 1.0)

    override func loadView() {
        logger.notice("Airlock notification extension loadView")

        let root = UIView()
        root.backgroundColor = background

        let card = UIView()
        card.translatesAutoresizingMaskIntoConstraints = false
        card.backgroundColor = panel
        card.layer.cornerRadius = 18
        card.layer.cornerCurve = .continuous

        root.addSubview(card)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            card.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            card.topAnchor.constraint(equalTo: root.topAnchor, constant: 10),
            card.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -10),
        ])

        rootStack.axis = .vertical
        rootStack.alignment = .fill
        rootStack.spacing = 9
        rootStack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(rootStack)

        NSLayoutConstraint.activate([
            rootStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            rootStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            rootStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 12),
            rootStack.bottomAnchor.constraint(lessThanOrEqualTo: card.bottomAnchor, constant: -12),
        ])

        buildHeader()
        buildArguments()
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        logger.notice("Airlock notification extension viewDidLoad")
        preferredContentSize = CGSize(width: view.bounds.width, height: 190)
        render(.loading)
    }

    func didReceive(_ notification: UNNotification) {
        logger.notice("Airlock notification extension didReceive category=\(notification.request.content.categoryIdentifier, privacy: .public)")
        render(ApprovalNotificationContext(notification: notification))
    }

    private func buildHeader() {
        let header = UIStackView()
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = 10

        let icon = UIImageView(image: UIImage(systemName: "lock.shield"))
        icon.tintColor = accent
        icon.backgroundColor = accent.withAlphaComponent(0.16)
        icon.contentMode = .center
        icon.layer.cornerRadius = 9
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 38),
            icon.heightAnchor.constraint(equalToConstant: 38),
        ])

        let titleStack = UIStackView()
        titleStack.axis = .vertical
        titleStack.spacing = 1

        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.textColor = primaryText
        titleLabel.numberOfLines = 1
        titleLabel.lineBreakMode = .byTruncatingTail

        metaLabel.font = .preferredFont(forTextStyle: .caption1)
        metaLabel.textColor = secondaryText
        metaLabel.numberOfLines = 1
        metaLabel.lineBreakMode = .byTruncatingTail

        titleStack.addArrangedSubview(titleLabel)
        titleStack.addArrangedSubview(metaLabel)

        timeoutLabel.font = .preferredFont(forTextStyle: .caption1)
        timeoutLabel.textAlignment = .right
        timeoutLabel.numberOfLines = 1
        timeoutLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        header.addArrangedSubview(icon)
        header.addArrangedSubview(titleStack)
        header.addArrangedSubview(timeoutLabel)
        rootStack.addArrangedSubview(header)
    }

    private func buildArguments() {
        let divider = UIView()
        divider.backgroundColor = UIColor(white: 1.0, alpha: 0.10)
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true

        sectionLabel.text = "Arguments"
        sectionLabel.font = .preferredFont(forTextStyle: .caption2)
        sectionLabel.textColor = secondaryText
        sectionLabel.numberOfLines = 1

        argsStack.axis = .vertical
        argsStack.alignment = .fill
        argsStack.spacing = 5

        rootStack.addArrangedSubview(divider)
        rootStack.addArrangedSubview(sectionLabel)
        rootStack.addArrangedSubview(argsStack)
    }

    private func render(_ context: ApprovalNotificationContext) {
        titleLabel.text = context.tool
        metaLabel.text = context.agentId
        timeoutLabel.text = context.timeoutText
        timeoutLabel.textColor = context.timeoutColor

        argsStack.arrangedSubviews.forEach { view in
            argsStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        let visibleArguments = context.visibleArguments
        let displayedArguments = Array(visibleArguments.prefix(5))
        if displayedArguments.isEmpty {
            argsStack.addArrangedSubview(emptyLabel("No arguments"))
        } else {
            for argument in displayedArguments {
                argsStack.addArrangedSubview(argumentRow(argument))
            }
            if visibleArguments.count > displayedArguments.count {
                argsStack.addArrangedSubview(emptyLabel("+\(visibleArguments.count - displayedArguments.count) more"))
            }
        }

        let rowHeight = displayedArguments.reduce(CGFloat(0)) { partial, argument in
            partial + estimatedRowHeight(for: argument)
        }
        let overflowHeight: CGFloat = visibleArguments.count > displayedArguments.count ? 22 : 0
        let contentHeight = max(168, min(360, 108 + rowHeight + overflowHeight))
        preferredContentSize = CGSize(width: view.bounds.width, height: contentHeight)
    }

    private func argumentRow(_ argument: ApprovalArgument) -> UIView {
        let row = UIStackView()
        row.axis = .vertical
        row.alignment = .fill
        row.spacing = 2

        let key = UILabel()
        key.text = argument.displayKey
        key.font = .preferredFont(forTextStyle: .caption2)
        key.textColor = secondaryText
        key.numberOfLines = 1
        key.lineBreakMode = .byTruncatingTail

        let value = UILabel()
        value.text = argument.value
        value.font = .preferredFont(forTextStyle: .caption1)
        value.textColor = primaryText
        value.numberOfLines = 3
        value.lineBreakMode = .byTruncatingTail

        row.addArrangedSubview(key)
        row.addArrangedSubview(value)
        return row
    }

    private func estimatedRowHeight(for argument: ApprovalArgument) -> CGFloat {
        switch argument.value.count {
        case 0...48:
            return 34
        case 49...120:
            return 52
        default:
            return 68
        }
    }

    private func emptyLabel(_ value: String) -> UILabel {
        let label = UILabel()
        label.text = value
        label.font = .preferredFont(forTextStyle: .caption1)
        label.textColor = secondaryText
        label.numberOfLines = 1
        return label
    }
}

private struct ApprovalNotificationContext {
    var agentId: String
    var tool: String
    var reason: String?
    var note: String?
    var args: [ApprovalArgument]
    var expiresAt: Date?

    static let loading = ApprovalNotificationContext(
        agentId: "Airlock",
        tool: "Approval",
        reason: nil,
        note: nil,
        args: [],
        expiresAt: nil
    )

    init(agentId: String, tool: String, reason: String? = nil, note: String? = nil, args: [ApprovalArgument], expiresAt: Date?) {
        self.agentId = agentId
        self.tool = tool
        self.reason = reason
        self.note = note
        self.args = args
        self.expiresAt = expiresAt
    }

    init(notification: UNNotification) {
        let content = notification.request.content
        let userInfo = content.userInfo
        let airlock = Self.dictionary(from: userInfo["airlock"])
        let approval = Self.dictionary(from: airlock?["approval"])
        let rawArgs = Self.argumentDictionaries(from: approval?["args"])

        agentId = approval?["agentId"] as? String
            ?? approval?["agent_id"] as? String
            ?? userInfo["agent_id"] as? String
            ?? Self.agentId(from: content.title)
        tool = approval?["tool"] as? String
            ?? userInfo["tool"] as? String
            ?? Self.tool(from: content.title)
        reason = Self.trimmed(approval?["reason"] as? String)
        note = Self.trimmed(approval?["note"] as? String)
        args = rawArgs?.compactMap(ApprovalArgument.init(rawValue:)) ?? Self.args(from: content.body)
        expiresAt = Self.parseDate(approval?["expiresAt"] as? String ?? approval?["expires_at"] as? String)
    }

    var visibleArguments: [ApprovalArgument] {
        let contextArgs = [
            reason.map { ApprovalArgument(key: "request_reason", value: $0) },
            note.map { ApprovalArgument(key: "request_note", value: $0) }
        ].compactMap { $0 }
        let argumentArgs = args.filter { $0.key != "code" && $0.key != "reason" && $0.key != "note" }
            .sorted { $0.key < $1.key }
        return contextArgs + argumentArgs
    }

    var timeoutText: String {
        guard let expiresAt else { return "No timeout" }
        let remaining = expiresAt.timeIntervalSinceNow
        if remaining <= 0 { return "Expired" }
        let minutes = Int(ceil(remaining / 60))
        if minutes < 60 { return "\(minutes)m left" }
        let hours = Int(ceil(Double(minutes) / 60))
        return "\(hours)h left"
    }

    var timeoutColor: UIColor {
        guard let expiresAt else { return UIColor(white: 0.68, alpha: 1.0) }
        let remaining = expiresAt.timeIntervalSinceNow
        if remaining <= 0 { return .systemRed }
        if remaining < 60 { return .systemOrange }
        return UIColor(white: 0.68, alpha: 1.0)
    }

    private static func parseDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        if let date = ISO8601DateFormatter.airlockWithFractionalSeconds.date(from: value) {
            return date
        }
        return ISO8601DateFormatter.airlock.date(from: value)
    }

    private static func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    private static func agentId(from title: String) -> String {
        let parts = title.split(separator: ":", maxSplits: 1).map(String.init)
        return parts.first?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Airlock"
    }

    private static func tool(from title: String) -> String {
        let parts = title.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count > 1 else { return "Approval" }
        return parts[1].trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Approval"
    }

    private static func args(from body: String) -> [ApprovalArgument] {
        body
            .split(separator: "\n")
            .compactMap { line -> ApprovalArgument? in
                let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { return nil }
                let key = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
                let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
                guard !key.isEmpty, !value.isEmpty else { return nil }
                return ApprovalArgument(key: key, value: value)
            }
    }

    private static func dictionary(from value: Any?) -> [String: Any]? {
        if let dictionary = value as? [String: Any] {
            return dictionary
        }
        if let dictionary = value as? [AnyHashable: Any] {
            return dictionary.reduce(into: [String: Any]()) { result, entry in
                if let key = entry.key as? String {
                    result[key] = entry.value
                }
            }
        }
        return nil
    }

    private static func argumentDictionaries(from value: Any?) -> [[String: Any]]? {
        if let arguments = value as? [[String: Any]] {
            return arguments
        }
        if let arguments = value as? [[AnyHashable: Any]] {
            return arguments.map { dictionary in
                dictionary.reduce(into: [String: Any]()) { result, entry in
                    if let key = entry.key as? String {
                        result[key] = entry.value
                    }
                }
            }
        }
        return nil
    }
}

private struct ApprovalArgument {
    let key: String
    let value: String

    var displayKey: String {
        switch key {
        case "command_preview":
            return "Command"
        case "review_hint":
            return "Review"
        default:
            return key
                .split(separator: "_")
                .map { word in
                    word.prefix(1).uppercased() + word.dropFirst()
                }
                .joined(separator: " ")
        }
    }

    init(key: String, value: String) {
        self.key = key
        self.value = value
    }

    init?(rawValue: [String: Any]) {
        guard let key = rawValue["key"] as? String else { return nil }
        self.key = key
        value = rawValue["value"] as? String ?? ""
    }
}

private extension ISO8601DateFormatter {
    static let airlockWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let airlock: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
