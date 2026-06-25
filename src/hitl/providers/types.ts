import type { SandboxDisplayInfo } from '../../sandbox/index.js';
import type { AirlockCallContext } from '../../airlock/context.js';
import type { AirlockActivityEvent } from '../../activity/stream.js';

export interface HitlNotification {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  badgeCount?: number;
  sandbox?: SandboxDisplayInfo;
  context?: AirlockCallContext;
}

export interface HitlProvider {
  init(): Promise<void>;
  notify(requests: HitlNotification[]): Promise<void>;
  updateBadge?(badgeCount: number): Promise<void>;
  updateApprovalStatus?(status: {
    id: string;
    code: string;
    result: 'approved' | 'denied' | 'timeout' | 'cancelled';
    badgeCount: number;
  }): Promise<void>;
  notifyActivity?(event: AirlockActivityEvent): Promise<void>;
  stop(): Promise<void>;
}

export interface ApprovalApi {
  approve(id: string): void;
  deny(id: string, reason?: string): void;
  approveByCode(code: string): void;
  denyByCode(code: string, reason?: string): void;
}
