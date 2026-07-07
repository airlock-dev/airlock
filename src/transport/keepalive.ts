import type { Server } from 'http';
import type { Socket } from 'net';

/**
 * Default TCP keep-alive idle before the OS starts probing a peer. Chosen well under the
 * transport's long-lived-stream lifetimes so a silently dead peer is detected within a bounded
 * window rather than pinning its MCP session forever.
 */
export const DEFAULT_KEEPALIVE_IDLE_MS = 60_000;

/**
 * Enable TCP keep-alive on every connection an HTTP server accepts.
 *
 * Why this exists: a StreamableHTTP/SSE MCP session holds a long-lived response stream open for
 * the life of a request — including a tool call parked for minutes/hours awaiting HITL approval,
 * or a call blocked on a hung downstream. If the client then vanishes WITHOUT a clean shutdown
 * (half-open TCP — laptop sleep, network partition, an OOM-killed container that never sends
 * FIN/RST), the socket never emits 'close', the transport's onclose never fires, and the
 * session's in-flight marker stays > 0. That permanently exempts it from the idle reaper (which
 * deliberately skips in-flight sessions so it never severs a legitimate HITL park), so the
 * session leaks its per-agent slot until the gateway restarts — eventually starving the agent's
 * concurrent-session cap and rejecting every new connection.
 *
 * OS-level keep-alive probes surface the dead peer within a bounded window; the socket then
 * closes and the EXISTING onclose path reclaims the session. This changes no reaping semantics:
 * a genuinely live client (HITL park, long async call) keeps answering probes and is never
 * severed — only silently-dead peers are.
 */
export function enableTcpKeepAlive(server: Server, idleMs: number = DEFAULT_KEEPALIVE_IDLE_MS): void {
  server.on('connection', (socket: Socket) => {
    socket.setKeepAlive(true, idleMs);
  });
}
