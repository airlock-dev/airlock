import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'http';
import type { AirlockActivityEvent } from '../activity/stream.js';
import type { HitlNotification, HitlProvider } from './providers/types.js';

const KEEPALIVE_MS = 25_000;

type ApprovalStatus = Parameters<NonNullable<HitlProvider['updateApprovalStatus']>>[0];

interface ActivityReplaySource {
  recent(): AirlockActivityEvent[];
}

export interface ApprovalStreamClient {
  addClient(request: FastifyRequest, reply: FastifyReply): void;
}

export class ApprovalStreamHub implements ApprovalStreamClient {
  private clients = new Map<ServerResponse, NodeJS.Timeout>();
  private pending = new Map<string, HitlNotification>();

  constructor(private options: { activityStream?: ActivityReplaySource } = {}) {}

  notify(requests: HitlNotification[]): Promise<void> {
    for (const request of requests) {
      this.pending.set(request.code, request);
      this.broadcast({ type: 'new', request });
    }
    return Promise.resolve();
  }

  updateApprovalStatus(status: ApprovalStatus): Promise<void> {
    this.pending.delete(status.code);
    this.broadcast({
      type: 'resolved',
      id: status.id,
      code: status.code,
      action: status.result,
      result: status.result,
      badgeCount: status.badgeCount,
    });
    return Promise.resolve();
  }

  notifyActivity(event: AirlockActivityEvent): Promise<void> {
    this.broadcast({ type: 'activity', event });
    return Promise.resolve();
  }

  addClient(request: FastifyRequest, reply: FastifyReply): void {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const keepalive = setInterval(() => {
      this.write(reply.raw, ': ping\n\n');
    }, KEEPALIVE_MS);
    keepalive.unref?.();
    this.clients.set(reply.raw, keepalive);

    this.write(reply.raw, ': connected\n\n');
    for (const pendingRequest of this.pending.values()) {
      this.writeEvent(reply.raw, { type: 'new', request: pendingRequest });
    }
    for (const event of [...(this.options.activityStream?.recent() ?? [])].reverse()) {
      this.writeEvent(reply.raw, { type: 'activity', event });
    }

    const cleanup = () => this.removeClient(reply.raw);
    request.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  }

  getPending(code: string): HitlNotification | undefined {
    return this.pending.get(code);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  stop(): Promise<void> {
    for (const client of this.clients.keys()) {
      try {
        client.end();
      } catch {
        /* swallow */
      }
      this.removeClient(client);
    }
    this.clients.clear();
    this.pending.clear();
    return Promise.resolve();
  }

  private broadcast(data: unknown): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients.keys()) {
      this.write(client, msg);
    }
  }

  private writeEvent(client: ServerResponse, data: unknown): void {
    this.write(client, `data: ${JSON.stringify(data)}\n\n`);
  }

  private write(client: ServerResponse, message: string): void {
    try {
      client.write(message);
    } catch {
      this.removeClient(client);
    }
  }

  private removeClient(client: ServerResponse): void {
    const keepalive = this.clients.get(client);
    if (keepalive) clearInterval(keepalive);
    this.clients.delete(client);
  }
}
