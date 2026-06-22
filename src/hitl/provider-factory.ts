import type { HitlProvider, ApprovalApi } from './providers/types.js';
import type { HitlProviderConfig } from '../config/schema.js';
import { CompositeHitlProvider } from './providers/composite.js';
import { StdioHitlProvider } from './providers/stdio.js';
import { TelegramHitlProvider } from './providers/telegram.js';
import { OpenClawHitlProvider } from './providers/openclaw.js';
import { SlackHitlProvider } from './providers/slack.js';
import { WebhookHitlProvider } from './providers/webhook.js';
import { TuiHitlProvider } from './providers/tui.js';
import { MacosHitlProvider } from './providers/macos.js';
import { DashboardHitlProvider } from './providers/dashboard.js';
import { IOSHitlProvider } from './providers/ios.js';
import { childLogger } from '../util/logger.js';
import type { AuditLogger } from '../audit/logger.js';

const log = childLogger('hitl-factory');

export function createHitlProvider(
  cfg: HitlProviderConfig | HitlProviderConfig[],
  approvalApi: ApprovalApi,
  options: { configPath?: string; auditLogger?: AuditLogger } = {}
): HitlProvider {
  if (Array.isArray(cfg)) {
    const providers = cfg.map((c) => createSingleProvider(c, approvalApi, options));
    return providers.length === 1 ? providers[0] : new CompositeHitlProvider(providers);
  }
  return createSingleProvider(cfg, approvalApi, options);
}

function createSingleProvider(
  cfg: HitlProviderConfig,
  approvalApi: ApprovalApi,
  options: { configPath?: string; auditLogger?: AuditLogger }
): HitlProvider {
  switch (cfg.type) {
    case 'telegram':
      return new TelegramHitlProvider(
        { bot_token: cfg.bot_token, chat_id: cfg.chat_id },
        approvalApi
      );
    case 'openclaw':
      return new OpenClawHitlProvider(
        { gateway_url: cfg.gateway_url, token: cfg.token, session_key: cfg.session_key },
        approvalApi
      );
    case 'slack':
      return new SlackHitlProvider({ webhook_url: cfg.webhook_url });
    case 'webhook':
      return new WebhookHitlProvider({ url: cfg.url, headers: cfg.headers });
    case 'tui':
      return new TuiHitlProvider(approvalApi);
    case 'macos':
      return new MacosHitlProvider(approvalApi, { sound: cfg.sound });
    case 'dashboard':
      return new DashboardHitlProvider(
        { host: cfg.host, port: cfg.port, config_path: options.configPath },
        approvalApi
      );
    case 'ios':
      if (!options.auditLogger) {
        log.warn('iOS HITL provider requires audit logger, falling back to stdio');
        return new StdioHitlProvider(approvalApi);
      }
      return new IOSHitlProvider(
        {
          teamId: cfg.team_id,
          keyId: cfg.key_id,
          keyPath: cfg.key_path,
          bundleId: cfg.bundle_id,
          production: cfg.production,
          ...(cfg.interruption_level ? { interruptionLevel: cfg.interruption_level } : {}),
        },
        options.auditLogger
      );
    case 'stdio':
      return new StdioHitlProvider(approvalApi);
    default:
      log.warn(
        { type: (cfg as { type: string }).type },
        'Unknown HITL provider type, falling back to stdio'
      );
      return new StdioHitlProvider(approvalApi);
  }
}
