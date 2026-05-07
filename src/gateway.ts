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
import { hookApiPlugin } from './hook/api.js';
import { toolsApiPlugin } from './tools/api.js';
import { sseServerPlugin } from './transport/sse-server.js';
import { httpServerPlugin } from './transport/http-server.js';
import type { AgentServerDeps } from './transport/agent-server.js';
import type { Config } from './config/loader.js';
import type { HitlProvider, ApprovalApi } from './hitl/providers/types.js';
import { createHitlProvider } from './hitl/provider-factory.js';
import { getMcpConfigs } from './config/schema.js';
import { buildAdapters } from './backend/factory.js';
import { childLogger } from './util/logger.js';

const log = childLogger('gateway');

export class Gateway {
  private pool!: ClientPool;
  private registry!: ToolRegistry;
  private allowlist!: AllowlistEngine;
  private hitlEngine!: HitlEngine;
  private hitlBatcher!: HitlBatcher;
  private hitlProvider!: HitlProvider;
  private auditLogger!: AuditLogger;
  private app!: FastifyInstance;
  private startTime = Date.now();

  constructor(private config: Config) {}

  async start(): Promise<void> {
    log.info('Starting Airlock gateway');

    // Audit logger
    this.auditLogger = new AuditLogger(this.config.audit);
    this.auditLogger.startDailyCleanup();

    // Approvals — provider needs approvalApi but engine doesn't exist yet, use forwarder
    this.hitlBatcher = new HitlBatcher(this.config.approvals.batch_window_ms);

    const approvalForwarder: ApprovalApi = {
      approve: (code) => this.hitlEngine.approve(code),
      deny: (code, reason) => this.hitlEngine.deny(code, reason),
    };

    this.hitlProvider = createHitlProvider(this.config.approvals.provider, approvalForwarder);

    this.hitlEngine = new HitlEngine(
      this.auditLogger,
      this.hitlProvider,
      this.config.approvals.timeout_ms
    );

    // Wire batcher → provider
    this.hitlBatcher.onBatchReady((_agentId, requests) => {
      void this.hitlProvider
        .notify(requests)
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

    // HTTP server
    this.app = Fastify({ logger: false });

    const secret = this.config.server.api_secret;

    await this.app.register(hitlApiPlugin, { engine: this.hitlEngine, secret });
    await this.app.register(auditApiPlugin, { auditLogger: this.auditLogger, secret });
    await this.app.register(hookApiPlugin, {
      allowlist: this.allowlist,
      hitlEngine: this.hitlEngine,
      hitlBatcher: this.hitlBatcher,
      auditLogger: this.auditLogger,
      secret,
    });
    await this.app.register(toolsApiPlugin, {
      getDeps: (agentId: string) => this.buildAgentDeps(agentId),
      secret,
    });
    await this.app.register(sseServerPlugin, {
      getDeps: (agentId: string) => this.buildAgentDeps(agentId),
      secret,
    });
    await this.app.register(httpServerPlugin, {
      getDeps: (agentId: string) => this.buildAgentDeps(agentId),
      secret,
    });

    this.app.get('/health', () => {
      const mcpHealth = this.pool.healthCheck();
      const pendingApprovals = this.hitlEngine.getPending().length;
      const uptime = Math.floor((Date.now() - this.startTime) / 1000);
      return { status: 'ok', mcpHealth, pendingApprovals, uptime };
    });

    const { port, host } = this.config.server;
    await this.app.listen({ port, host });
    log.info({ port, host }, 'Airlock gateway listening');
  }

  buildAgentDeps(agentId: string): AgentServerDeps | undefined {
    const agentConfig = this.config.agents[agentId];
    if (!agentConfig) return undefined;

    return {
      agentId,
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
