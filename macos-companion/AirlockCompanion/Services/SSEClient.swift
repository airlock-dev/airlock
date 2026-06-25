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

private enum SSEOpenResult: Sendable {
    case accepted
    case rejected(Int)
    case failed(String)
}

private struct SSEConnectionError: LocalizedError {
    let message: String

    var errorDescription: String? { message }

    static func status(_ statusCode: Int) -> SSEConnectionError {
        SSEConnectionError(message: DashboardConnectionStatusError(statusCode: statusCode).localizedDescription)
    }
}

private func waitForSSEOpen(_ delegate: SSESessionDelegate, timeout: TimeInterval) async -> SSEOpenResult {
    await withTaskGroup(of: SSEOpenResult.self) { group in
        group.addTask {
            await delegate.waitUntilOpen()
        }
        group.addTask {
            try? await Task.sleep(for: .seconds(timeout))
            return .failed("Stream did not open within \(Int(timeout)) seconds")
        }

        let result = await group.next() ?? .failed("Stream closed before response")
        group.cancelAll()
        return result
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
        cancelStream(updateState: false)

        let (stream, continuation) = AsyncStream<SSEMessage>.makeStream()
        let currentConnection = connection

        streamTask = Task.detached { [weak self] in
            let weakSelf = self
            var reconnectDelay = Constants.Reconnect.initialDelay

            while !Task.isCancelled {
                await MainActor.run { weakSelf?.connectionState = .connecting }

                do {
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
                    defer {
                        task.cancel()
                        session.invalidateAndCancel()
                    }

                    switch await waitForSSEOpen(delegate, timeout: Constants.Reconnect.openTimeout) {
                    case .accepted:
                        await MainActor.run { weakSelf?.connectionState = .connected }
                        reconnectDelay = Constants.Reconnect.initialDelay
                    case .rejected(let statusCode):
                        throw SSEConnectionError.status(statusCode)
                    case .failed(let message):
                        throw SSEConnectionError(message: message)
                    }

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

                    if !Task.isCancelled {
                        throw SSEConnectionError(message: "Stream closed by server")
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
        cancelStream(updateState: true)
    }

    private func cancelStream(updateState: Bool) {
        streamTask?.cancel()
        streamTask = nil
        if updateState {
            connectionState = .disconnected(nil)
        }
    }
}

// MARK: - Delegate-based SSE streaming

/// Streams SSE data via URLSessionDataDelegate, which delivers chunks as they arrive
/// without waiting for the full response to complete.
private final class SSESessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lineContinuation: AsyncStream<String>.Continuation
    private let openContinuation: AsyncStream<SSEOpenResult>.Continuation
    let lines: AsyncStream<String>
    private let openResults: AsyncStream<SSEOpenResult>

    private var buffer = Data()
    private let lock = NSLock()
    private var didCompleteOpen = false

    override init() {
        let (lStream, lCont) = AsyncStream<String>.makeStream()
        let (oStream, oCont) = AsyncStream<SSEOpenResult>.makeStream()
        self.lines = lStream
        self.lineContinuation = lCont
        self.openResults = oStream
        self.openContinuation = oCont
        super.init()
    }

    func waitUntilOpen() async -> SSEOpenResult {
        var iterator = openResults.makeAsyncIterator()
        return await iterator.next() ?? .failed("Stream closed before response")
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        guard let httpResponse = response as? HTTPURLResponse else {
            completeOpen(.failed("Invalid stream response"))
            lineContinuation.finish()
            completionHandler(.cancel)
            return
        }

        if (200...299).contains(httpResponse.statusCode) {
            completeOpen(.accepted)
            completionHandler(.allow)
        } else {
            completeOpen(.rejected(httpResponse.statusCode))
            lineContinuation.finish()
            completionHandler(.cancel)
        }
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
        if let error {
            completeOpen(.failed(error.localizedDescription))
        } else {
            completeOpen(.failed("Stream closed before response"))
        }
        lineContinuation.finish()
    }

    private func completeOpen(_ result: SSEOpenResult) {
        lock.lock()
        guard !didCompleteOpen else {
            lock.unlock()
            return
        }
        didCompleteOpen = true
        lock.unlock()

        openContinuation.yield(result)
        openContinuation.finish()
    }
}
