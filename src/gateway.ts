import { randomUUID } from 'crypto';
import { createConnection, isIP } from 'net';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ClientPool } from './pool/pool.js';
import { ToolRegistry } from './registry/registry.js';
import { AllowlistEngine } from './allowlist/engine.js';
import { HitlEngine } from './hitl/engine.js';
import { HitlBatcher } from './hitl/batcher.js';
import { AuditLogger } from './audit/logger.js';
import { hitlApiPlugin } from './hitl/api.js';
import { auditApiPlugin } from './audit/api.js';
import { mobileApiPlugin } from './mobile/api.js';
import { hookApiPlugin } from './hook/api.js';
import { toolsApiPlugin } from './tools/api.js';
import { ApprovalDashboardRoutes } from './hitl/approval-dashboard.js';
import { CompositeHitlProvider } from './hitl/providers/composite.js';
import { sseServerPlugin } from './transport/sse-server.js';
import { httpServerPlugin } from './transport/http-server.js';
import type { AgentServerDeps } from './transport/agent-server.js';
import type { Config } from './config/loader.js';
import type { HitlProvider, ApprovalApi } from './hitl/providers/types.js';
import { createHitlProvider } from './hitl/provider-factory.js';
import { getMcpConfigs } from './config/schema.js';
import { buildAdapters } from './backend/factory.js';
import { childLogger } from './util/logger.js';
import { checkRequestSecurity } from './security/request.js';

const log = childLogger('gateway');

export interface GatewayOptions {
  runtimeOnly?: boolean;
}

export class Gateway {
  private pool!: ClientPool;
  private registry!: ToolRegistry;
  private allowlist!: AllowlistEngine;
  private hitlEngine!: HitlEngine;
  private hitlBatcher!: HitlBatcher;
  private hitlProvider!: HitlProvider;
  private approvalRoutes!: ApprovalDashboardRoutes;
  private auditLogger!: AuditLogger;
  private app!: FastifyInstance;
  private managementApp?: FastifyInstance;
  private downstreamSessionIds = new Map<string, string>();
  private startTime = Date.now();

  constructor(
    private config: Config,
    private configPath?: string,
    private options: GatewayOptions = {}
  ) {}

  async start(): Promise<void> {
    log.info('Starting Airlock gateway');
    this.assertManagementApiConfig();

    // Audit logger
    this.auditLogger = new AuditLogger(this.config.audit);
    this.auditLogger.startDailyCleanup();

    // Approvals — provider needs approvalApi but engine doesn't exist yet, use forwarder
    this.hitlBatcher = new HitlBatcher(this.config.approvals.batch_window_ms);

    const approvalForwarder: ApprovalApi = {
      approve: (code) => this.hitlEngine.approve(code),
      deny: (code, reason) => this.hitlEngine.deny(code, reason),
    };

    this.approvalRoutes = new ApprovalDashboardRoutes(approvalForwarder);
    this.hitlProvider = this.buildHitlProvider(approvalForwarder);

    this.hitlEngine = new HitlEngine(
      this.auditLogger,
      this.hitlProvider,
      this.config.approvals.timeout_ms
    );

    // Wire batcher → provider
    this.hitlBatcher.onBatchReady((_agentId, requests) => {
      const badgeCount = this.hitlEngine.getPending().length;
      void this.hitlProvider
        .notify(requests.map((request) => ({ ...request, badgeCount })))
        .catch((err) => log.error({ err }, 'Failed to send approval notifications'));
    });

    await this.hitlProvider.init();
    await this.hitlEngine.recoverPending();

    // MCP pool — only connect to actual MCP servers, not builtins
    const mcpConfigs = getMcpConfigs(this.config.providers);
    this.pool = new ClientPool(mcpConfigs);
    await this.pool.initialize();

    // Build adapters from config (MCP, builtins, CLIs, APIs)
    const adapters = buildAdapters(this.config, this.pool);

    // Allowlist + registry
    this.allowlist = new AllowlistEngine(this.config.agents);
    this.registry = new ToolRegistry(adapters, this.allowlist, this.config.agents);

    // Register callback for late-connecting MCPs (after registry exists)
    this.pool.onClientReady((id) => {
      log.info({ id }, 'MCP became ready, refreshing tool registry');
      this.registry
        .refresh()
        .catch((err) => log.error({ err }, 'Failed to refresh registry after MCP ready'));
    });

    await this.registry.refresh();

    // Agent data-plane server. Control-plane routes are registered on a
    // separate listener below and must never be added to this app.
    this.app = Fastify({ logger: false });

    const dataPlaneRequestSecurity = {
      secret: this.config.server.api_secret,
      authRequired: this.config.server.auth_required,
      allowedOrigins: this.config.server.allowed_origins,
    };
    const managementRequestSecurity = {
      secret: this.config.server.management_api.api_secret ?? this.config.server.api_secret,
      authRequired: true,
      allowedOrigins: this.config.server.allowed_origins,
    };

    await this.app.register(sseServerPlugin, {
      getDeps: (agentId: string) => this.buildAgentDeps(agentId),
      ...dataPlaneRequestSecurity,
    });
    await this.app.register(httpServerPlugin, {
      getDeps: (agentId: string) => this.buildAgentDeps(agentId),
      ...dataPlaneRequestSecurity,
    });
    if (this.config.server.expose_tools_api) {
      await this.app.register(toolsApiPlugin, {
        getDeps: (agentId: string, downstreamSessionKey?: string) =>
          this.buildAgentDeps(agentId, downstreamSessionKey),
        requiresSessionId: (agentId: string, tool: string) =>
          this.requiresToolsApiSessionId(agentId, tool),
        ...dataPlaneRequestSecurity,
      });
    }

    const { port, host } = this.config.server;
    await this.app.listen({ port, host });
    log.info({ port, host }, 'Airlock agent data-plane listening');

    if (this.config.server.management_api.enabled) {
      try {
        await this.startManagementApi(managementRequestSecurity);
      } catch (err) {
        await this.app.close().catch((closeErr) => {
          log.warn(
            { err: closeErr },
            'Failed to close agent data-plane after management API startup failure'
          );
        });
        throw err;
      }
    }
  }

  private async startManagementApi(requestSecurity: {
    secret?: string;
    authRequired: boolean;
    allowedOrigins: string[];
  }): Promise<void> {
    const management = this.config.server.management_api;
    this.managementApp = Fastify({ logger: false });

    await this.managementApp.register(hitlApiPlugin, {
      engine: this.hitlEngine,
      ...requestSecurity,
    });
    await this.managementApp.register(auditApiPlugin, {
      auditLogger: this.auditLogger,
      ...requestSecurity,
    });
    await this.managementApp.register(mobileApiPlugin, {
      auditLogger: this.auditLogger,
      engine: this.hitlEngine,
      configPath: this.configPath,
      ...requestSecurity,
    });
    await this.managementApp.register((adminApp, _opts, done) => {
      adminApp.addHook('preHandler', (request, reply, hookDone) => {
        if (!checkRequestSecurity(request, reply, requestSecurity)) {
          return;
        }
        hookDone();
      });
      this.approvalRoutes.registerRoutes(adminApp);
      adminApp.get('/admin/tools', (_request, reply) => {
        return reply.send({ tools: this.registry.getAllTools(), errors: [] });
      });
      done();
    });

    if (management.expose_hook_api) {
      await this.managementApp.register(hookApiPlugin, {
        allowlist: this.allowlist,
        hitlEngine: this.hitlEngine,
        hitlBatcher: this.hitlBatcher,
        auditLogger: this.auditLogger,
        ...requestSecurity,
      });
    }

    this.managementApp.get('/health', async (request, reply) => {
      if (!checkRequestSecurity(request, reply, requestSecurity)) return;
      const dataPlane = await this.dataPlaneHealth();
      const mcpHealth = this.pool.healthCheck();
      const pendingApprovals = this.hitlEngine.getPending().length;
      const uptime = Math.floor((Date.now() - this.startTime) / 1000);
      const status = dataPlane.status === 'ok' ? 'ok' : 'degraded';
      return { status, dataPlane, mcpHealth, pendingApprovals, uptime };
    });

    const { port, host, insecure_remote_bind } = management;
    if (insecure_remote_bind) {
      log.warn(
        { port, host },
        'Control-plane bound beyond loopback; admin/audit/approval routes may be reachable off-host. Restrict this listener with network ACLs.'
      );
    }

    await this.managementApp.listen({ port, host });
    log.info({ port, host }, 'Airlock control-plane management API listening');
  }

  private async dataPlaneHealth(): Promise<{
    status: 'ok' | 'down';
    host: string;
    port: number;
  }> {
    const address = this.app.server.address();
    const host =
      typeof address === 'object' && address !== null ? address.address : this.config.server.host;
    const port =
      typeof address === 'object' && address !== null ? address.port : this.config.server.port;
    const status = await tcpProbe(connectableLoopbackHost(host), port, 250);
    return { status: status ? 'ok' : 'down', host, port };
  }

  private assertManagementApiConfig(): void {
    const management = this.config.server.management_api;
    if (!management.enabled) return;

    if (!management.api_secret && !this.config.server.api_secret) {
      throw new Error(
        'server.management_api.enabled requires server.management_api.api_secret or server.api_secret.'
      );
    }

    const tokenlessAgents = Object.entries(this.config.agents)
      .filter(([, agent]) => !agent.token)
      .map(([agentId]) => agentId);
    if (tokenlessAgents.length > 0) {
      throw new Error(
        `server.management_api.enabled requires per-agent tokens. Add token to agents: ${tokenlessAgents.join(', ')}.`
      );
    }

    if (!isLoopbackHost(management.host) && !management.insecure_remote_bind) {
      throw new Error(
        'server.management_api.host is non-loopback while insecure_remote_bind is false. Keep it on 127.0.0.1/::1, or explicitly set server.management_api.insecure_remote_bind: true and restrict the control-plane port with network ACLs.'
      );
    }

    if (management.port !== 0 && management.port === this.config.server.port) {
      throw new Error('Control-plane and data-plane must not share a socket.');
    }
  }

  private buildHitlProvider(approvalForwarder: ApprovalApi): HitlProvider {
    const providers: HitlProvider[] = [];
    const configuredProvider = this.options.runtimeOnly
      ? withoutDashboardProvider(this.config.approvals.provider)
      : this.config.approvals.provider;

    if (configuredProvider) {
      providers.push(
        createHitlProvider(configuredProvider, approvalForwarder, {
          configPath: this.configPath,
          auditLogger: this.auditLogger,
        })
      );
    }
    providers.push(this.approvalRoutes);

    return providers.length === 1 ? providers[0] : new CompositeHitlProvider(providers);
  }

  buildAgentDeps(agentId: string, downstreamSessionKey?: string): AgentServerDeps | undefined {
    const agentConfig = this.config.agents[agentId];
    if (!agentConfig) return undefined;
    const downstreamSessionId = downstreamSessionKey
      ? this.downstreamSessionIdFor(downstreamSessionKey)
      : undefined;

    return {
      agentId,
      downstreamSessionId,
      agentConfig,
      getAgentConfig: () => this.config.agents[agentId] ?? agentConfig,
      registry: this.registry,
      allowlist: this.allowlist,
      hitlEngine: this.hitlEngine,
      hitlBatcher: this.hitlBatcher,
      hitlProvider: this.hitlProvider,
      auditLogger: this.auditLogger,
      securityConfig: this.config.security,
    };
  }

  private downstreamSessionIdFor(key: string): string {
    let id = this.downstreamSessionIds.get(key);
    if (!id) {
      id = randomUUID();
      this.downstreamSessionIds.set(key, id);
    }
    return id;
  }

  private requiresToolsApiSessionId(agentId: string, toolName: string): boolean {
    const agentConfig = this.config.agents[agentId];
    if (!agentConfig) return false;

    const resolvedToolName = agentConfig.tool_overrides[toolName]?.alias_of ?? toolName;
    const separatorIndex = resolvedToolName.indexOf('/');
    if (separatorIndex <= 0) return false;

    const providerId = resolvedToolName.slice(0, separatorIndex);
    return providerId in getMcpConfigs(this.config.providers);
  }

  async reload(newConfig: Config): Promise<void> {
    log.info('Reloading gateway config');
    this.config = newConfig;
    const mcpConfigs = getMcpConfigs(newConfig.providers);
    await this.pool.reload(mcpConfigs);
    this.allowlist.reload(newConfig.agents);
    this.registry.reloadAgents(newConfig.agents);
    // Rebuild adapters to pick up new CLIs/APIs
    const adapters = buildAdapters(newConfig, this.pool);
    this.registry.setAdapters(adapters);
    await this.registry.refresh();
    log.info('Config reloaded: providers, allowlist, registry, and agent configs updated');
  }

  /** Prevent MCP clients from reconnecting during shutdown. */
  disableReconnect(): void {
    this.pool?.disableReconnect();
  }

  async stop(): Promise<void> {
    log.info('Stopping Airlock gateway');
    this.pool?.disableReconnect();
    await this.pool?.stop();
    await this.managementApp?.close();
    await this.app?.close();
    await this.registry?.stopAll();
    await this.hitlProvider?.stop();
    this.auditLogger?.stop();
  }

  /** SIGKILL any child processes that survived graceful stop. */
  forceKill(): void {
    this.pool?.forceKill();
  }
}

function withoutDashboardProvider(
  provider: Config['approvals']['provider']
): Config['approvals']['provider'] | undefined {
  if (Array.isArray(provider)) {
    const filtered = provider.filter((entry) => entry.type !== 'dashboard');
    if (filtered.length === 0) return undefined;
    return filtered.length === 1 ? filtered[0] : filtered;
  }
  return provider.type === 'dashboard' ? undefined : provider;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 6) return normalized === '::1';
  if (ipVersion !== 4) return false;
  const firstOctet = Number(normalized.split('.')[0]);
  return firstOctet === 127;
}

function connectableLoopbackHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
