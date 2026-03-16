export interface HitlNotification {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  /** When true, this is a fire-and-forget notification — no approval needed. */
  notifyOnly?: boolean;
}

export interface HitlProvider {
  init(): Promise<void>;
  notify(requests: HitlNotification[]): Promise<void>;
  stop(): Promise<void>;
}

export interface ApprovalApi {
  approve(id: string): void;
  deny(id: string, reason?: string): void;
}
