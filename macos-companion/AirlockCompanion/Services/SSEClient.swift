import Foundation

enum ConnectionState: Equatable, Sendable {
    case connecting
    case connected
    case disconnected(String?)

    static func == (lhs: ConnectionState, rhs: ConnectionState) -> Bool {
        switch (lhs, rhs) {
        case (.connecting, .connecting), (.connected, .connected):
            return true
        case (.disconnected(let a), .disconnected(let b)):
            return a == b
        default:
            return false
        }
    }
}

@MainActor
final class SSEClient: ObservableObject {
    @Published var connectionState: ConnectionState = .disconnected(nil)

    private var connection: DashboardConnection
    private var streamTask: Task<Void, Never>?

    init(baseURL: String = Constants.defaultDashboardURL, bearerToken: String? = nil) {
        self.connection = DashboardConnection(baseURL: baseURL, bearerToken: bearerToken)
    }

    func updateBaseURL(_ url: String) {
        updateConnection(baseURL: url, bearerToken: connection.bearerToken)
    }

    func updateConnection(baseURL: String, bearerToken: String? = nil) {
        connection = DashboardConnection(baseURL: baseURL, bearerToken: bearerToken)
    }

    func connect() -> AsyncStream<SSEMessage> {
        disconnect()

        let (stream, continuation) = AsyncStream<SSEMessage>.makeStream()
        let currentConnection = connection

        streamTask = Task.detached { [weak self] in
            let weakSelf = self
            var reconnectDelay = Constants.Reconnect.initialDelay

            while !Task.isCancelled {
                await MainActor.run { weakSelf?.connectionState = .connecting }

                do {
                    // First, verify the server is reachable with a quick health check.
                    // The SSE endpoint doesn't flush headers until first data,
                    // so we can't rely on the SSE response to confirm connectivity.
                    var checkReq = try currentConnection.request(path: Constants.healthPath, timeoutInterval: 5)
                    let (_, checkResp) = try await URLSession.shared.data(for: checkReq)
                    guard let httpResp = checkResp as? HTTPURLResponse,
                          httpResp.statusCode == 200 || httpResp.statusCode == 404
                    else {
                        throw URLError(.badServerResponse)
                    }
                    if httpResp.statusCode == 404 {
                        checkReq = try currentConnection.request(path: "/", timeoutInterval: 5)
                        let (_, fallbackResp) = try await URLSession.shared.data(for: checkReq)
                        guard let fallbackHttpResp = fallbackResp as? HTTPURLResponse,
                              fallbackHttpResp.statusCode == 200
                        else {
                            throw URLError(.badServerResponse)
                        }
                    }

                    // Server is up — mark as connected and start SSE stream
                    await MainActor.run { weakSelf?.connectionState = .connected }
                    reconnectDelay = Constants.Reconnect.initialDelay

                    // Use delegate-based streaming since URLSession.bytes(for:)
                    // waits for initial data before returning, which hangs on
                    // SSE streams with no pending events.
                    let delegate = SSESessionDelegate()
                    let config = URLSessionConfiguration.default
                    config.timeoutIntervalForRequest = .infinity
                    config.timeoutIntervalForResource = .infinity
                    let session = URLSession(
                        configuration: config,
                        delegate: delegate,
                        delegateQueue: nil
                    )

                    var request = try currentConnection.request(
                        path: Constants.sseEventsPath,
                        accept: "text/event-stream"
                    )
                    request.timeoutInterval = .infinity

                    let task = session.dataTask(with: request)
                    task.resume()

                    // Process incoming SSE lines
                    for await line in delegate.lines {
                        if Task.isCancelled { break }

                        if line.hasPrefix("data: ") {
                            let jsonString = String(line.dropFirst(6))
                            if let data = jsonString.data(using: .utf8),
                               let message = SSEMessage.parse(from: data) {
                                continuation.yield(message)
                            }
                        }
                    }

                    task.cancel()
                    session.invalidateAndCancel()

                    if !Task.isCancelled {
                        await MainActor.run { weakSelf?.connectionState = .disconnected(nil) }
                    }
                } catch {
                    if Task.isCancelled { break }
                    await MainActor.run { weakSelf?.connectionState = .disconnected(error.localizedDescription) }
                }

                if Task.isCancelled { break }

                try? await Task.sleep(for: .seconds(reconnectDelay))
                reconnectDelay = min(
                    reconnectDelay * Constants.Reconnect.multiplier,
                    Constants.Reconnect.maxDelay
                )
            }

            continuation.finish()
        }

        return stream
    }

    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        connectionState = .disconnected(nil)
    }
}

// MARK: - Delegate-based SSE streaming

/// Streams SSE data via URLSessionDataDelegate, which delivers chunks as they arrive
/// without waiting for the full response to complete.
private final class SSESessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lineContinuation: AsyncStream<String>.Continuation
    let lines: AsyncStream<String>

    private var buffer = Data()
    private let lock = NSLock()

    override init() {
        let (lStream, lCont) = AsyncStream<String>.makeStream()
        self.lines = lStream
        self.lineContinuation = lCont
        super.init()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        buffer.append(data)

        while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[buffer.startIndex..<newlineIndex]
            buffer.removeSubrange(buffer.startIndex...newlineIndex)

            if let line = String(data: lineData, encoding: .utf8) {
                lineContinuation.yield(line)
            }
        }
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        lineContinuation.finish()
    }
}
