import type { SandboxDisplayInfo } from '../../sandbox/index.js';

export interface HitlNotification {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  badgeCount?: number;
  sandbox?: SandboxDisplayInfo;
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
  stop(): Promise<void>;
}

export interface ApprovalApi {
  approve(id: string): void;
  deny(id: string, reason?: string): void;
}
