import { ClientPool } from './pool/pool.js';
import { requiredMcpsForAgent } from './pool/required-mcps.js';
import { ToolRegistry } from './registry/registry.js';
import { AllowlistEngine } from './allowlist/engine.js';
import { HitlEngine } from './hitl/engine.js';
import { HitlBatcher } from './hitl/batcher.js';
import { AuditLogger } from './audit/logger.js';
import { StdioHitlProvider } from './hitl/providers/stdio.js';
import { TelegramHitlProvider } from './hitl/providers/telegram.js';
import { OpenClawHitlProvider } from './hitl/providers/openclaw.js';
import { runStdioServer } from './transport/stdio-server.js';
import type { Config } from './config/loader.js';
import type { HitlProvider, ApprovalApi } from './hitl/providers/types.js';
import { childLogger } from './util/logger.js';

const log = childLogger('stdio-mode');

export async function runStdioMode(config: Config, agentId: string): Promise<void> {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Unknown agent profile: ${agentId}`);
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
  const hitlProvider = buildHitlProvider(config, approvalForwarder);

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

function buildHitlProvider(config: Config, approvalApi: ApprovalApi): HitlProvider {
  const cfg = config.hitl.provider;
  switch (cfg.type) {
    case 'telegram':
      return new TelegramHitlProvider({ bot_token: cfg.bot_token, chat_id: cfg.chat_id }, approvalApi);
    case 'openclaw':
      return new OpenClawHitlProvider(
        { gateway_url: cfg.gateway_url, token: cfg.token, session_key: cfg.session_key },
        approvalApi,
      );
    default:
      return new StdioHitlProvider(approvalApi);
  }
}
