import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ClientPool } from './pool/pool.js';
import { requiredMcpsForAgent } from './pool/required-mcps.js';
import { ToolRegistry } from './registry/registry.js';
import { AllowlistEngine } from './allowlist/engine.js';
import { HitlEngine } from './hitl/engine.js';
import { HitlBatcher } from './hitl/batcher.js';
import { AuditLogger } from './audit/logger.js';
import { hitlApiPlugin } from './hitl/api.js';
import { auditApiPlugin } from './audit/api.js';
import { mobileApiPlugin } from './mobile/api.js';
import { ApprovalStreamHub } from './hitl/approval-stream.js';
import { createHitlProvider } from './hitl/provider-factory.js';
import { CompositeHitlProvider } from './hitl/providers/composite.js';
import { runStdioServer } from './transport/stdio-server.js';
import { ConfigWatcher } from './config/watcher.js';
import type { Config } from './config/loader.js';
import type { ApprovalApi } from './hitl/providers/types.js';
import { getBuiltinProviders, getMcpConfigs, getProviderInstructions } from './config/schema.js';
import { buildAdapters } from './backend/factory.js';
import { ActivityStream } from './activity/stream.js';
import { checkRequestSecurity, type RequestSecurityOptions } from './security/request.js';
import { childLogger } from './util/logger.js';

const log = childLogger('stdio-mode');

export async function runStdioMode(
  config: Config,
  agentId: string,
  configPath: string
): Promise<void> {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Unknown agent profile: ${agentId}`);
  }

  // Stdio mode uses stdin/stdout for MCP protocol — the stdio approval provider
  // also reads from stdin, which would corrupt the MCP transport.
  const providers = Array.isArray(config.approvals.provider)
    ? config.approvals.provider
    : [config.approvals.provider];
  if (providers.some((p) => p.type === 'stdio')) {
    throw new Error(
      'Cannot use approval provider "stdio" in stdio mode — both the MCP transport and approval ' +
        'provider would read from stdin. Use "telegram", "slack", "webhook", or "openclaw" instead.'
    );
  }

  log.info({ agentId }, 'Starting Airlock in stdio mode');
  const downstreamSessionId = randomUUID();

  let currentAgentConfig = agentConfig;

  // Audit
  const auditLogger = new AuditLogger(config.audit);
  auditLogger.startDailyCleanup();

  // Approvals — provider is created before engine, so forward calls via closure
  // eslint-disable-next-line prefer-const
  let hitlEngine!: HitlEngine;
  const approvalForwarder: ApprovalApi = {
    approve: (id) => hitlEngine.approve(id),
    deny: (id, reason) => hitlEngine.deny(id, reason),
    approveByCode: (code) => hitlEngine.approveByCode(code),
    denyByCode: (code, reason) => hitlEngine.denyByCode(code, reason),
  };

  const hitlBatcher = new HitlBatcher(config.approvals.batch_window_ms);
  const activityStream = new ActivityStream();
  const approvalStream = new ApprovalStreamHub({ activityStream });
  const configuredHitlProvider = createHitlProvider(config.approvals.provider, approvalForwarder, {
    configPath,
    auditLogger,
    approvalStream,
  });
  const hitlProvider = new CompositeHitlProvider([configuredHitlProvider, approvalStream]);
  const unsubscribeActivityNotifications = activityStream.subscribe((event) => {
    void hitlProvider
      .notifyActivity?.(event)
      .catch((err) => log.error({ err }, 'Failed to send activity notification'));
  });

  hitlEngine = new HitlEngine(auditLogger, hitlProvider, config.approvals.timeout_ms);

  hitlBatcher.onBatchReady((_agentId, requests) => {
    const badgeCount = hitlEngine.getPending().length;
    void hitlProvider
      .notify(requests.map((request) => ({ ...request, badgeCount })))
      .catch((err) => log.error({ err }, 'Failed to send approval notification'));
  });

  await hitlProvider.init();
  await hitlEngine.recoverPending();

  // Pool — only the MCPs this profile actually needs
  const mcpConfigs = getMcpConfigs(config.providers);
  const allMcpIds = Object.keys(mcpConfigs);
  const neededIds = requiredMcpsForAgent(agentConfig, allMcpIds);
  const filteredMcps = Object.fromEntries(neededIds.map((id) => [id, mcpConfigs[id]]));

  log.info(
    { agentId, needed: neededIds, skipped: allMcpIds.filter((id) => !neededIds.includes(id)) },
    'Connecting to required MCPs only'
  );

  const pool = new ClientPool(filteredMcps);
  await pool.initialize();

  const allowlist = new AllowlistEngine(config.agents);
  let activeConfig = config;
  const registryRef: { current?: ToolRegistry } = {};

  const airlockDeps = () => ({
    hitlEngine,
    hitlBatcher,
    activityStream,
    getAgentTools: (id: string) => registryRef.current?.getFilteredWithDecisions(id) ?? [],
    getAgentConfig: (id: string) => activeConfig.agents[id],
    getKnownProviderIds: () => knownProviderIds(activeConfig),
    getProviderConnectionStatus: (providerId: string) =>
      providerConnectionStatus(activeConfig, pool, providerId),
  });

  // Build adapters from config (MCP, builtins, CLIs, APIs)
  const adapters = buildAdapters(config, pool, {
    airlock: airlockDeps(),
  });

  const registry = new ToolRegistry(
    adapters,
    allowlist,
    config.agents,
    getProviderInstructions(config.providers)
  );
  registryRef.current = registry;

  // Register callback for late-connecting MCPs (after registry exists)
  pool.onClientReady((id) => {
    log.info({ id }, 'MCP became ready, refreshing tool registry');
    registry
      .refresh()
      .catch((err) => log.error({ err }, 'Failed to refresh registry after MCP ready'));
  });

  await registry.refresh();

  const managementRequestSecurity: RequestSecurityOptions = {};
  updateManagementRequestSecurity(config, managementRequestSecurity);
  let managementApp: FastifyInstance | undefined;
  if (config.server.management_api?.enabled) {
    managementApp = await startManagementApi({
      config,
      auditLogger,
      hitlEngine,
      activityStream,
      configPath,
      approvalStream,
      getRequestSecurity: () => managementRequestSecurity,
    });
  }

  // Hot reload — allowlists, agent config, security (not MCP connections or approval provider)
  const watcher = new ConfigWatcher(configPath);
  watcher.on('reload', (newConfig) => {
    try {
      if (newConfig.agents[agentId]) {
        currentAgentConfig = newConfig.agents[agentId];
      }
      activeConfig = newConfig;
      updateManagementRequestSecurity(newConfig, managementRequestSecurity);
      const newMcpConfigs = getMcpConfigs(newConfig.providers);
      pool
        .reload(newMcpConfigs)
        .then(() => {
          allowlist.reload(newConfig.agents);
          registry.reloadAgents(newConfig.agents, getProviderInstructions(newConfig.providers));
          const newAdapters = buildAdapters(newConfig, pool, {
            airlock: airlockDeps(),
          });
          registry.setAdapters(newAdapters);
          return registry.refresh();
        })
        .then(() => {
          log.info('Config reloaded: providers, allowlist, agent config, security');
        })
        .catch((err) => {
          log.error({ err }, 'Failed to apply reloaded config');
        });
    } catch (err) {
      log.error({ err }, 'Failed to apply reloaded config');
    }
  });
  watcher.start();

  // Graceful shutdown
  let shuttingDown = false;
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    watcher.stop();
    await managementApp?.close().catch(() => {});
    await pool.stop();
    await registry.stopAll();
    await hitlProvider.stop();
    unsubscribeActivityNotifications();
    auditLogger.stop();
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down stdio mode');
    // Immediately prevent MCP clients from reconnecting — SIGINT
    // propagates to children, killing them before pool.stop() runs.
    pool.disableReconnect();
    // The MCP SDK's StdioClientTransport.close() escalates:
    //   stdin.end → 2s wait → SIGTERM → 2s wait → SIGKILL
    // Give it enough time (5s) before forcing exit, otherwise
    // process.exit() orphans children mid-cleanup.
    const forceExit = setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit');
      pool.forceKill();
      process.exit(1);
    }, 5000);
    forceExit.unref();
    try {
      await cleanup();
    } catch (err) {
      log.error({ err }, 'Error during stdio shutdown');
    }
    process.exit(0);
  };

  const handleSigterm = () => void shutdown();
  const handleSigint = () => void shutdown();
  process.on('SIGTERM', handleSigterm);
  process.on('SIGINT', handleSigint);

  try {
    await runStdioServer({
      agentId,
      downstreamSessionId,
      agentConfig,
      getAgentConfig: () => currentAgentConfig,
      registry,
      allowlist,
      hitlEngine,
      hitlBatcher,
      hitlProvider,
      auditLogger,
      securityConfig: config.security,
    });
  } finally {
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);
    if (!shuttingDown) {
      await cleanup();
    }
  }
}

function knownProviderIds(config: Config): string[] {
  const ids = new Set<string>([
    ...Object.keys(getMcpConfigs(config.providers)),
    ...getBuiltinProviders(config.providers),
    ...Object.keys(config.clis ?? {}),
    ...Object.keys(config.apis ?? {}),
  ]);
  return Array.from(ids).sort();
}

function providerConnectionStatus(config: Config, pool: ClientPool, providerId: string) {
  if (!(providerId in getMcpConfigs(config.providers))) return undefined;
  return (
    pool.getProviderConnectionStatus(providerId) ?? {
      status: 'down' as const,
      reason: 'MCP provider is not connected',
    }
  );
}

function updateManagementRequestSecurity(config: Config, target: RequestSecurityOptions): void {
  target.secret = config.server.management_api?.api_secret ?? config.server.api_secret;
  target.authRequired = true;
  target.allowedOrigins = config.server.allowed_origins;
}

async function startManagementApi(opts: {
  config: Config;
  auditLogger: AuditLogger;
  hitlEngine: HitlEngine;
  activityStream: ActivityStream;
  configPath: string;
  approvalStream: ApprovalStreamHub;
  getRequestSecurity: () => RequestSecurityOptions;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const {
    auditLogger,
    hitlEngine,
    activityStream,
    configPath,
    approvalStream,
    getRequestSecurity,
  } = opts;

  await app.register(hitlApiPlugin, {
    engine: hitlEngine,
    getRequestSecurity,
  });
  await app.register(auditApiPlugin, {
    auditLogger,
    getRequestSecurity,
  });
  await app.register(mobileApiPlugin, {
    auditLogger,
    engine: hitlEngine,
    activityStream,
    configPath,
    getRequestSecurity,
    approvalStream,
  });

  app.get('/health', async (request, reply) => {
    if (!checkRequestSecurity(request, reply, getRequestSecurity())) return;
    return {
      status: 'ok',
      pendingApprovals: hitlEngine.getPending().length,
    };
  });

  const { port, host } = opts.config.server.management_api;
  await app.listen({ port, host });
  log.info({ port, host }, 'Airlock stdio management API listening');
  return app;
}
