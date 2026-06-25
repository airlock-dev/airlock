import { randomUUID } from 'crypto';
import { ClientPool } from './pool/pool.js';
import { requiredMcpsForAgent } from './pool/required-mcps.js';
import { ToolRegistry } from './registry/registry.js';
import { AllowlistEngine } from './allowlist/engine.js';
import { HitlEngine } from './hitl/engine.js';
import { HitlBatcher } from './hitl/batcher.js';
import { AuditLogger } from './audit/logger.js';
import { createHitlProvider } from './hitl/provider-factory.js';
import { runStdioServer } from './transport/stdio-server.js';
import { ConfigWatcher } from './config/watcher.js';
import type { Config } from './config/loader.js';
import type { ApprovalApi } from './hitl/providers/types.js';
import { getMcpConfigs } from './config/schema.js';
import { buildAdapters } from './backend/factory.js';
import { ActivityStream } from './activity/stream.js';
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
  const hitlProvider = createHitlProvider(config.approvals.provider, approvalForwarder, {
    configPath,
    auditLogger,
  });
  const activityStream = new ActivityStream();
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

  // Build adapters from config (MCP, builtins, CLIs, APIs)
  const adapters = buildAdapters(config, pool, {
    airlock: { hitlEngine, hitlBatcher, activityStream },
  });

  const allowlist = new AllowlistEngine(config.agents);
  const registry = new ToolRegistry(adapters, allowlist, config.agents);

  // Register callback for late-connecting MCPs (after registry exists)
  pool.onClientReady((id) => {
    log.info({ id }, 'MCP became ready, refreshing tool registry');
    registry
      .refresh()
      .catch((err) => log.error({ err }, 'Failed to refresh registry after MCP ready'));
  });

  await registry.refresh();

  // Hot reload — allowlists, agent config, security (not MCP connections or approval provider)
  const watcher = new ConfigWatcher(configPath);
  watcher.on('reload', (newConfig) => {
    try {
      if (newConfig.agents[agentId]) {
        currentAgentConfig = newConfig.agents[agentId];
      }
      const newMcpConfigs = getMcpConfigs(newConfig.providers);
      pool
        .reload(newMcpConfigs)
        .then(() => {
          allowlist.reload(newConfig.agents);
          registry.reloadAgents(newConfig.agents);
          const newAdapters = buildAdapters(newConfig, pool, {
            airlock: { hitlEngine, hitlBatcher, activityStream },
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
      watcher.stop();
      await pool.stop();
      await registry.stopAll();
      await hitlProvider.stop();
      unsubscribeActivityNotifications();
      auditLogger.stop();
    } catch (err) {
      log.error({ err }, 'Error during stdio shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // No HTTP server — stdio only
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
}
