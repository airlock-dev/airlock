import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rememberAllow, type RememberAllowMode } from '../config/mutator.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';
import type { ApprovalStreamHub } from './approval-stream.js';
import type { ApprovalApi, HitlNotification } from './providers/types.js';
import type { ApprovalPreviewReader } from './preview.js';
import { GrantSpecError } from './engine.js';
import { parseGrantSpecInput, rememberToGrantSpec } from './grant-api.js';

const log = childLogger('hitl-dashboard');

let latestVersionCache: { version: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

export class ApprovalDashboardRoutes {
  constructor(
    private approvalApi: ApprovalApi,
    private stream: ApprovalStreamHub,
    private previews?: ApprovalPreviewReader
  ) {}

  registerRoutes(app: FastifyInstance, configPath?: string): void {
    app.get('/events', (request, reply) => this.handleEvents(request, reply));
    app.post('/approve', async (request, reply) => this.handleApprove(request, reply, configPath));
    app.post('/deny', (request, reply) => this.handleDeny(request, reply));
    this.registerPreviewRoute(app);
    app.get('/version', () => ({ version: VERSION }));
    app.get('/version/latest', async (_request, reply) => this.handleLatestVersion(reply));
  }

  registerPreviewRoute(app: FastifyInstance): void {
    app.post('/approval-preview/:id', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { id } = request.params as { id: string };
      const pending = this.stream.getPendingById(id);
      if (this.previews ? !this.previews.isPending(id) : !pending) {
        return reply.code(409).send({ error: 'Approval has resolved or is unavailable.' });
      }
      const preview = this.previews
        ? await this.previews.readPending(id)
        : { status: 'unavailable' };
      if (this.previews && !this.previews.isPending(id)) {
        return reply.code(409).send({ error: 'Approval has resolved.' });
      }
      return preview;
    });
  }

  private handleEvents(request: FastifyRequest, reply: FastifyReply): void {
    this.stream.addClient(request, reply);
  }

  private handleApprove(
    request: FastifyRequest,
    reply: FastifyReply,
    configPath?: string
  ): { ok: true } | { error: string } {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code) return { ok: true };

    const pendingRequest = this.stream.getPendingByCode(code);
    const remember = typeof query.remember === 'string' ? query.remember : undefined;
    // `grant_scope=tool|tier|provider|profile` (+ grant_tier, grant_profile, duration_ms, max_uses)
    // widens the approval into a grant. Legacy `remember=temporary` is a tool grant.
    const grant =
      typeof query.grant_scope === 'string'
        ? parseGrantSpecInput({
            scope: query.grant_scope,
            tier: query.grant_tier,
            profile: query.grant_profile,
            duration_ms: query.duration_ms,
            max_uses: query.max_uses,
          })
        : rememberToGrantSpec(remember, query.duration_ms);
    if (grant.error) {
      reply.code(400);
      return { error: grant.error };
    }
    const persistRemember = remember !== undefined && remember !== 'temporary';
    if (persistRemember) {
      const invalid = this.validateRemember(configPath, pendingRequest, remember);
      if (invalid) {
        reply.code(invalid.status);
        return { error: invalid.error };
      }
    }

    // Approve (validating any grant) before persisting an "always" rule, so a rejected grant never
    // leaves a permanent config change behind.
    try {
      this.approvalApi.approveByCode(code, grant.spec ? { grant: grant.spec } : undefined);
    } catch (err) {
      if (err instanceof GrantSpecError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
    log.info({ code, grant: grant.spec }, 'Approved via dashboard');

    if (persistRemember) {
      const result = this.rememberDecision(configPath, pendingRequest, remember, query.duration_ms);
      if (result.error) {
        reply.code(result.status);
        return { error: result.error };
      }
    }
    return { ok: true };
  }

  private handleDeny(request: FastifyRequest, _reply: FastifyReply): { ok: true } {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : '';
    if (code) {
      this.approvalApi.denyByCode(code, 'Denied via dashboard');
      log.info({ code }, 'Denied via dashboard');
    }
    return { ok: true };
  }

  private async handleLatestVersion(
    reply: FastifyReply
  ): Promise<{ latest?: string; error?: string }> {
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

  private validateRemember(
    configPath: string | undefined,
    pendingRequest: HitlNotification | undefined,
    remember: string
  ): { status: number; error: string } | undefined {
    if (!configPath) return { status: 400, error: 'Config mutation is not available' };
    if (remember !== 'always') {
      return { status: 400, error: 'Invalid remember mode' };
    }
    if (!pendingRequest) return { status: 404, error: 'No pending request found for code' };
    if ((pendingRequest.kind ?? 'call') !== 'call' || pendingRequest.escalated) {
      return { status: 400, error: 'Only a routine tool call can be remembered' };
    }
    return undefined;
  }

  private rememberDecision(
    configPath: string | undefined,
    pendingRequest: HitlNotification | undefined,
    remember: string,
    durationMsValue: unknown
  ): { status: number; error?: string } {
    const invalid = this.validateRemember(configPath, pendingRequest, remember);
    if (invalid || !configPath || !pendingRequest) {
      return invalid ?? { status: 400, error: 'Config mutation is not available' };
    }

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
      log.error(
        { err, code: pendingRequest.code, remember },
        'Failed to update config from approval decision'
      );
      return { status: 500, error: 'Failed to update config' };
    }
  }
}
