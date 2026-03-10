import { ClientPool } from './pool/pool.js';
import { requiredMcpsForAgent } from './pool/required-mcps.js';
import { ToolRegistry } from './registry/registry.js';
import { AllowlistEngine } from './allowlist/engine.js';
import { HitlEngine } from './hitl/engine.js';
import { HitlBatcher } from './hitl/batcher.js';
import { AuditLogger } from './audit/logger.js';
import { createHitlProvider } from './hitl/provider-factory.js';
import { runStdioServer } from './transport/stdio-server.js';
import type { Config } from './config/loader.js';
import type { ApprovalApi } from './hitl/providers/types.js';
import { childLogger } from './util/logger.js';

const log = childLogger('stdio-mode');

export async function runStdioMode(config: Config, agentId: string): Promise<void> {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Unknown agent profile: ${agentId}`);
  }

  // Stdio mode uses stdin/stdout for MCP protocol — the stdio HITL provider
  // also reads from stdin, which would corrupt the MCP transport.
  if (config.hitl.provider.type === 'stdio') {
    throw new Error(
      'Cannot use hitl provider "stdio" in stdio mode — both the MCP transport and HITL ' +
      'provider would read from stdin. Use "telegram", "slack", "webhook", or "openclaw" instead.',
    );
  }

  log.info({ agentId }, 'Starting Airlock in stdio mode');

  // Audit
  const auditLogger = new AuditLogger(config.audit);
  auditLogger.startDailyCleanup();

  // HITL — provider is created before engine, so forward calls via closure
  let hitlEngine!: HitlEngine;
  const approvalForwarder: ApprovalApi = {
    approve: (code) => hitlEngine.approve(code),
    deny: (code, reason) => hitlEngine.deny(code, reason),
  };

  const hitlBatcher = new HitlBatcher(config.hitl.batch_window_ms);
  const hitlProvider = createHitlProvider(config.hitl.provider, approvalForwarder);

  hitlEngine = new HitlEngine(auditLogger, hitlProvider, config.hitl.timeout_ms);

  hitlBatcher.onBatchReady((_agentId, requests) => {
    void hitlProvider.notify(requests).catch(err =>
      log.error({ err }, 'Failed to send HITL notification'),
    );
  });

  await hitlProvider.init();
  await hitlEngine.recoverPending();

  // Pool — only the MCPs this profile actually needs
  const allMcpIds = Object.keys(config.mcps);
  const neededIds = requiredMcpsForAgent(agentConfig, allMcpIds);
  const filteredMcps = Object.fromEntries(neededIds.map(id => [id, config.mcps[id]]));

  log.info(
    { agentId, needed: neededIds, skipped: allMcpIds.filter(id => !neededIds.includes(id)) },
    'Connecting to required MCPs only',
  );

  const pool = new ClientPool(filteredMcps);
  await pool.initialize();

  const allowlist = new AllowlistEngine(config.agents);
  const registry = new ToolRegistry(pool, allowlist, config.agents, config.security);
  await registry.refresh();

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down stdio mode');
    try {
      await pool.stop();
      await hitlProvider.stop();
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
    agentConfig,
    registry,
    allowlist,
    hitlEngine,
    hitlBatcher,
    hitlProvider,
    auditLogger,
  });
}
