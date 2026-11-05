export type Decision = 'allow' | 'ask' | 'deny';
export type Resolved = Decision | 'none';
export type Kind = 'agent' | 'profile';

export interface Rules {
  extends: string[];
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface Agent extends Rules {
  hasToken: boolean;
  inheritDefault: boolean;
  approvalMode?: 'sync' | 'async';
  exec: { allow: string[]; ask: string[]; deny: string[] };
  http: { domainAllowlist: string[] };
}

export type Profile = Rules;

export interface Provider {
  type: 'builtin' | 'stdio' | 'sse' | 'http';
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
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
  assistant: { enabled: boolean; model?: string };
}

export interface AgentSpec {
  extends?: string[];
  allow?: string[];
  ask?: string[];
  deny?: string[];
  inherit_default?: boolean;
  approval_mode?: 'sync' | 'async' | null;
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
  timeoutMs: number;
  tier?: 'read' | 'write' | 'destructive';
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
