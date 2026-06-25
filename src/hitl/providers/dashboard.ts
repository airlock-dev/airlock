import type { FastifyInstance } from 'fastify';
import type { AirlockActivityEvent } from '../../activity/stream.js';
import { createConfigureWebApp } from '../../configure-web/cli.js';
import { childLogger } from '../../util/logger.js';
import { ApprovalDashboardRoutes } from '../approval-dashboard.js';
import type { ApprovalStreamHub } from '../approval-stream.js';
import type { ApprovalApi, HitlNotification, HitlProvider } from './types.js';

const log = childLogger('hitl-dashboard');

export interface DashboardHitlConfig {
  host: string;
  port: number;
  config_path?: string;
}

export class DashboardHitlProvider implements HitlProvider {
  private app?: FastifyInstance;
  private approvalRoutes?: ApprovalDashboardRoutes;

  constructor(
    private config: DashboardHitlConfig,
    private approvalApi: ApprovalApi,
    private approvalStream: ApprovalStreamHub
  ) {}

  async init(): Promise<void> {
    if (!this.config.config_path) {
      log.warn('Dashboard provider requires a config path; running without dashboard UI');
      return;
    }

    this.approvalRoutes = new ApprovalDashboardRoutes(this.approvalApi, this.approvalStream);
    this.app = createConfigureWebApp(this.config.config_path, { approvals: this.approvalRoutes });

    try {
      await this.app.listen({ port: this.config.port, host: this.config.host });
      log.info({ host: this.config.host, port: this.config.port }, 'Airlock dashboard listening');
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code === 'EADDRINUSE') {
        log.warn({ port: this.config.port }, 'Dashboard port in use; running without dashboard UI');
      } else {
        log.error({ err }, 'Dashboard server error');
      }
      this.app = undefined;
      this.approvalRoutes = undefined;
    }
  }

  async stop(): Promise<void> {
    this.approvalRoutes = undefined;

    if (this.app) {
      await this.app.close().catch(() => {});
      this.app = undefined;
    }
  }

  notify(_requests: HitlNotification[]): Promise<void> {
    return Promise.resolve();
  }

  updateApprovalStatus(_status: {
    id: string;
    code: string;
    result: 'approved' | 'denied' | 'timeout' | 'cancelled';
    badgeCount: number;
  }): Promise<void> {
    return Promise.resolve();
  }

  notifyActivity(_event: AirlockActivityEvent): Promise<void> {
    return Promise.resolve();
  }
}
