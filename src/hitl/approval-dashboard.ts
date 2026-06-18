import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'http';
import { rememberAllow, type RememberAllowMode } from '../config/mutator.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';
import type { ApprovalApi, HitlNotification, HitlProvider } from './providers/types.js';

const log = childLogger('hitl-dashboard');

let latestVersionCache: { version: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

export class ApprovalDashboardRoutes implements HitlProvider {
  private clients = new Set<ServerResponse>();
  private pending = new Map<string, HitlNotification>();

  constructor(private approvalApi: ApprovalApi) {}

  init(): Promise<void> {
    return Promise.resolve();
  }

  registerRoutes(app: FastifyInstance, configPath?: string): void {
    app.get('/events', (request, reply) => this.handleEvents(request, reply));
    app.post('/approve', async (request, reply) => this.handleApprove(request, reply, configPath));
    app.post('/deny', (request, reply) => this.handleDeny(request, reply));
    app.get('/version', () => ({ version: VERSION }));
    app.get('/version/latest', async (_request, reply) => this.handleLatestVersion(reply));
  }

  notify(requests: HitlNotification[]): Promise<void> {
    for (const request of requests) {
      this.pending.set(request.code, request);
      this.broadcast({ type: 'new', request });
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* swallow */
      }
    }
    this.clients.clear();
    return Promise.resolve();
  }

  private handleEvents(request: FastifyRequest, reply: FastifyReply): void {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    this.clients.add(reply.raw);
    for (const pendingRequest of this.pending.values()) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'new', request: pendingRequest })}\n\n`);
    }
    request.raw.on('close', () => this.clients.delete(reply.raw));
  }

  private async handleApprove(
    request: FastifyRequest,
    reply: FastifyReply,
    configPath?: string
  ): Promise<{ ok: true } | { error: string }> {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code) return { ok: true };

    const pendingRequest = this.pending.get(code);
    const remember = typeof query.remember === 'string' ? query.remember : undefined;
    if (remember) {
      const result = this.rememberDecision(configPath, pendingRequest, remember, query.duration_ms);
      if (result.error) {
        reply.code(result.status);
        return { error: result.error };
      }
    }

    this.pending.delete(code);
    this.approvalApi.approve(code);
    this.broadcast({ type: 'resolved', code, action: 'approved' });
    log.info({ code }, 'Approved via dashboard');
    return { ok: true };
  }

  private handleDeny(
    request: FastifyRequest,
    _reply: FastifyReply
  ): { ok: true } {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : '';
    if (code) {
      this.pending.delete(code);
      this.approvalApi.deny(code, 'Denied via dashboard');
      this.broadcast({ type: 'resolved', code, action: 'denied' });
      log.info({ code }, 'Denied via dashboard');
    }
    return { ok: true };
  }

  private async handleLatestVersion(reply: FastifyReply): Promise<{ latest?: string; error?: string }> {
    const now = Date.now();
    if (latestVersionCache && now - latestVersionCache.fetchedAt < CACHE_TTL_MS) {
      return { latest: latestVersionCache.version };
    }

    try {
      const response = await fetch('https://registry.npmjs.org/airlock-bot/latest');
      const data = (await response.json()) as { version?: string };
      if (!data.version) throw new Error('Registry response did not include a version');
      latestVersionCache = { version: data.version, fetchedAt: now };
      return { latest: data.version };
    } catch (err) {
      log.warn({ err }, 'Failed to fetch latest version from npm');
      reply.code(502);
      return { error: 'Failed to fetch latest version' };
    }
  }

  private rememberDecision(
    configPath: string | undefined,
    pendingRequest: HitlNotification | undefined,
    remember: string,
    durationMsValue: unknown
  ): { status: number; error?: string } {
    if (!configPath) return { status: 400, error: 'Config mutation is not available' };
    if (remember !== 'always' && remember !== 'temporary') {
      return { status: 400, error: 'Invalid remember mode' };
    }
    if (!pendingRequest) return { status: 404, error: 'No pending request found for code' };

    const durationMs =
      typeof durationMsValue === 'string' && durationMsValue.trim()
        ? Number(durationMsValue)
        : undefined;
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) {
      return { status: 400, error: 'Invalid duration_ms' };
    }

    try {
      const result = rememberAllow({
        configPath,
        agentId: pendingRequest.agentId,
        tool: pendingRequest.tool,
        mode: remember as RememberAllowMode,
        ...(durationMs ? { durationMs } : {}),
      });
      log.info(result, 'Updated config from approval decision');
      return { status: 200 };
    } catch (err) {
      log.error({ err, code: pendingRequest.code, remember }, 'Failed to update config from approval decision');
      return { status: 500, error: 'Failed to update config' };
    }
  }

  private broadcast(data: unknown): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch {
        /* swallow */
      }
    }
  }
}
