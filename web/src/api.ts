import type {
  ActivityEvent,
  ApplyResult,
  AuditEntry,
  ChangeOp,
  ChangePreview,
  ChatMessage,
  DecideOptions,
  Grant,
  Meta,
  Proposal,
  State,
  Status,
  Tool,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    throw new ApiError(
      String(body.error ?? `Request failed (${response.status})`),
      response.status,
      body
    );
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  state: () => request<State>('/api/state'),
  meta: () => request<Meta>('/api/meta'),
  status: () => request<Status>('/api/status'),
  tools: () => request<{ tools: Tool[]; errors?: string[] }>('/api/tools'),
  logs: (query: Record<string, string>) => {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v));
    return request<{
      dbPath: string;
      entries: AuditEntry[];
      pending: unknown[];
      error?: string;
    }>('/api/logs' + (params.size ? `?${params}` : ''));
  },
  activity: () => request<{ events: ActivityEvent[] }>('/api/activity'),
  grants: (agent?: string) => {
    const suffix = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    return request<{ grants: Grant[]; canRevoke?: boolean; error?: string }>(
      `/api/grants${suffix}`
    );
  },
  revokeGrant: (id: string) =>
    request<{ ok: boolean }>(`/api/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  preview: (ops: ChangeOp[]) => post<ChangePreview>('/api/changes/preview', { ops }),
  apply: (ops: ChangeOp[], version?: string) =>
    post<ApplyResult>('/api/changes/apply', { ops, version }),
  saveProvider: (body: Record<string, unknown>) => post<State>('/api/providers', body),
  deleteProvider: (id: string) =>
    request<State>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  decide: (action: 'approve' | 'deny', code: string, options: DecideOptions = {}) => {
    const params = new URLSearchParams({ code });
    if (options.remember) params.set('remember', options.remember);
    if (options.grantScope) params.set('grant_scope', options.grantScope);
    if (options.grantTier) params.set('grant_tier', options.grantTier);
    if (options.grantProfile) params.set('grant_profile', options.grantProfile);
    if (options.durationMs) params.set('duration_ms', String(options.durationMs));
    if (options.maxUses) params.set('max_uses', String(options.maxUses));
    if (options.answer) params.set('answer', options.answer);
    return post<unknown>(`/${action}?${params}`);
  },
  approvalPreview: (id: string) =>
    post<Record<string, unknown>>(`/approval-preview/${encodeURIComponent(id)}`),
  chat: (messages: ChatMessage[]) =>
    post<{ messages: ChatMessage[]; proposals: Proposal[] }>('/api/assistant/chat', { messages }),
};
