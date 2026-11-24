export type Decision = 'allow' | 'ask' | 'deny';
export type Resolved = Decision | 'none';
export type Kind = 'agent' | 'profile';
export type ToolTier = 'read' | 'write' | 'destructive';
export type ThemePreference = 'system' | 'light' | 'dark';

export interface Rules {
  extends: string[];
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface Agent extends Rules {
  hasToken: boolean;
  inheritDefault: boolean;
  approvalMode?: 'hybrid' | 'sync' | 'async';
  exec: { allow: string[]; ask: string[]; deny: string[] };
  http: { domainAllowlist: string[] };
}

export type Profile = Rules;

export interface Provider {
  type: 'builtin' | 'stdio' | 'sse' | 'http';
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: boolean;
}

export interface Diagnostic {
  level: 'error' | 'warn' | 'info';
  message: string;
  agent?: string;
  suggestion?: string;
}

export interface State {
  configPath: string;
  providers: Record<string, Provider>;
  agents: Record<string, Agent>;
  profiles: Record<string, Profile>;
  defaultProfile?: string;
  diagnostics: Diagnostic[];
}

export interface Tool {
  name: string;
  provider: string;
  shortName: string;
  description: string;
  tags: string[];
  suspiciousPatterns: string[];
  recommended: Decision;
}

export interface ProviderStatus {
  id: string;
  type: Provider['type'];
  enabled: boolean;
  status: 'ok' | 'down' | 'disabled';
  toolCount: number;
  toolFingerprint: string;
  serverInfo?: { name: string; version: string };
  error?: string;
}

export interface Status {
  generatedAt: string;
  providers: ProviderStatus[];
  summary: { ok: number; down: number; disabled: number; tools: number; pendingApprovals: number };
}

export interface Meta {
  version: string;
  publicGatewayUrl: string | null;
  remoteGateway: boolean;
  /** False for `airlock run` / `configure-web`: pending requests are listed but not decidable. */
  approvals: boolean;
  assistant: { enabled: boolean; model?: string };
}

export interface AgentSpec {
  extends?: string[];
  allow?: string[];
  ask?: string[];
  deny?: string[];
  inherit_default?: boolean;
  approval_mode?: 'hybrid' | 'sync' | 'async' | null;
  exec?: { allow?: string[]; ask?: string[]; deny?: string[] };
  http?: { domain_allowlist?: string[] };
}

export type ChangeOp =
  | { op: 'create_agent'; id: string; agent: AgentSpec }
  | { op: 'update_agent'; id: string; agent: AgentSpec }
  | { op: 'delete_agent'; id: string }
  | { op: 'rotate_agent_key'; id: string }
  | { op: 'create_profile'; id: string; profile: Partial<Rules> }
  | { op: 'update_profile'; id: string; profile: Partial<Rules> }
  | { op: 'delete_profile'; id: string };

export interface EntityChange {
  kind: Kind;
  id: string;
  action: 'create' | 'update' | 'delete' | 'rotate';
  before: string | null;
  after: string | null;
}

export interface ChangePreview {
  ok: boolean;
  version: string;
  changes: EntityChange[];
  diagnostics: Diagnostic[];
  warnings: string[];
}

export interface ApplyResult {
  version: string;
  createdKeys: { agentId: string; key: string }[];
  changes: EntityChange[];
  state: State;
}

export interface AuditEntry {
  id?: number;
  ts: string;
  agent_id: string;
  tool: string;
  args: unknown;
  result: string;
  duration_ms?: number;
  error?: string;
  hitl_code?: string;
  request_id?: string;
}

export interface GrantOption {
  scope: 'tool' | 'tier' | 'provider' | 'profile';
  label: string;
  tier?: 'read' | 'write';
  profile?: string;
}

export type GrantScope =
  | { kind: 'call'; tool: string; fingerprint: string }
  | { kind: 'tool'; tool: string }
  | { kind: 'tier'; tier: 'read' | 'write'; provider?: string }
  | { kind: 'provider'; provider: string }
  | { kind: 'profile'; profile: string };

export interface Grant {
  id: string;
  agentId: string;
  scope: GrantScope;
  source: 'approval' | 'operator' | 'plan' | 'async' | string;
  label?: string;
  sessionId?: string;
  approvalId?: string;
  createdAt: string;
  expiresAt?: string;
  usesRemaining?: number;
}

export interface PlanCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface PendingApproval {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  reason?: string;
  note?: string;
  createdAt: string;
  expiresAt?: string;
  timeoutMs: number;
  kind: 'call' | 'plan' | 'question';
  /** `hybrid` while the call is held open; `async` once the agent was answered "pending". */
  mode?: 'hybrid' | 'sync' | 'async';
  /** Approving runs the call right away (the agent was answered "pending"). */
  executeOnApprove?: boolean;
  tier?: ToolTier;
  provider?: string;
  escalated?: boolean;
  plan?: PlanCall[];
  grantOptions?: GrantOption[];
  batchId?: string;
  batchCode?: string;
  batchSize?: number;
}

export interface DecideOptions {
  remember?: 'always' | 'temporary';
  grantScope?: 'tool' | 'tier' | 'provider' | 'profile';
  grantTier?: 'read' | 'write';
  grantProfile?: string;
  durationMs?: number;
  maxUses?: number;
  /** The answer to an airlock/ask_user question. */
  answer?: string;
}

export interface ActivityEvent {
  id: string;
  kind: 'notification' | 'log';
  agentId: string;
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  createdAt: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  ops: ChangeOp[];
  preview: ChangePreview;
}
