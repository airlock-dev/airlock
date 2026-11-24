import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

/**
 * Abort reason for "the client's connection went away". The MCP SDK aborts in-flight request
 * handlers with exactly this when a transport closes (socket drop, client timeout), while an explicit
 * `notifications/cancelled` aborts with the notification's own reason. Transports Airlock owns (the
 * legacy SSE session, the HTTP tools API) use the same reason so the two cases stay distinguishable.
 */
export function connectionClosedReason(message = 'Client disconnected'): SdkError {
  return new SdkError(SdkErrorCode.ConnectionClosed, message);
}

/** Whether this signal aborted because the connection dropped (vs an explicit cancellation). */
export function isConnectionDrop(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason as { code?: unknown } | undefined;
  return (
    typeof reason === 'object' && reason !== null && reason.code === SdkErrorCode.ConnectionClosed
  );
}
