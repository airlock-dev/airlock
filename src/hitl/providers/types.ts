import type { SandboxDisplayInfo } from '../../sandbox/index.js';
import type { AirlockCallContext } from '../../airlock/context.js';
import type { AirlockActivityEvent } from '../../activity/stream.js';
import type { GrantOption, GrantSpec, ToolTier } from '../grants.js';

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
  /** call (default) = one gated tool call; plan = several calls approved together; question = ask_user. */
  kind?: 'call' | 'plan' | 'question';
  tier?: ToolTier;
  provider?: string;
  /** Flagged by a detector or command policy: excluded from approve-all and grants. */
  escalated?: boolean;
  /** For kind=plan: the calls being approved up front. */
  plan?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** Grant scopes the operator can pick to also allow similar future calls. */
  grantOptions?: GrantOption[];
  /** Set when this request was notified together with others; approve/deny the batch by code. */
  batchId?: string;
  batchCode?: string;
  batchSize?: number;
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
    /** Present when the request was part of a notified batch. */
    batchId?: string;
    /** Members of that batch still pending after this resolution. */
    batchPending?: number;
  }): Promise<void>;
  notifyActivity?(event: AirlockActivityEvent): Promise<void>;
  stop(): Promise<void>;
}

export interface ApprovalApi {
  approve(id: string, options?: { grant?: GrantSpec }): void;
  deny(id: string, reason?: string): void;
  approveByCode(code: string, options?: { grant?: GrantSpec }): void;
  denyByCode(code: string, reason?: string): void;
}
