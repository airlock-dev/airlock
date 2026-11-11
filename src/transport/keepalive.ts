import type { Server } from 'http';
import type { Socket } from 'net';

/**
 * Default TCP keep-alive idle before the OS starts probing a peer. Chosen well under the
 * transport's long-lived-stream lifetimes so a silently dead peer is detected within a bounded
 * window rather than holding its stream open forever.
 */
export const DEFAULT_KEEPALIVE_IDLE_MS = 60_000;

/**
 * Enable TCP keep-alive on every connection an HTTP server accepts.
 *
 * Why this exists: several responses stay open for a long time — a legacy SSE agent session, a
 * streamable-HTTP tool call parked for minutes or hours awaiting HITL approval (or blocked on a
 * hung downstream), and the dashboard/companion approval streams. If the client then vanishes
 * WITHOUT a clean shutdown (half-open TCP — laptop sleep, network partition, an OOM-killed
 * container that never sends FIN/RST), the socket never emits 'close'. A parked call's abort
 * signal never fires, so its approval is never cancelled; an SSE session never closes, and since
 * SSE sessions are marked in-flight for their whole life the idle reaper never reclaims them
 * either, so the session keeps its per-agent slot until the gateway restarts.
 *
 * OS-level keep-alive probes surface the dead peer within a bounded window; the socket then
 * closes and the EXISTING close paths clean up. A genuinely live client (HITL park, long async
 * call) keeps answering probes and is never severed — only silently-dead peers are.
 */
export function enableTcpKeepAlive(
  server: Server,
  idleMs: number = DEFAULT_KEEPALIVE_IDLE_MS
): void {
  server.on('connection', (socket: Socket) => {
    socket.setKeepAlive(true, idleMs);
  });
}
