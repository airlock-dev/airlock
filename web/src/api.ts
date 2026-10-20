import type {
  ApplyResult,
  ChangeOp,
  ChangePreview,
  ChatMessage,
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
      entries: import('./types').AuditEntry[];
      pending: unknown[];
      error?: string;
    }>('/api/logs' + (params.size ? `?${params}` : ''));
  },
  activity: () => request<{ events: import('./types').ActivityEvent[] }>('/api/activity'),
  preview: (ops: ChangeOp[]) => post<ChangePreview>('/api/changes/preview', { ops }),
  apply: (ops: ChangeOp[], version?: string) =>
    post<ApplyResult>('/api/changes/apply', { ops, version }),
  saveProvider: (body: Record<string, unknown>) => post<State>('/api/providers', body),
  deleteProvider: (id: string) =>
    request<State>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  decide: (action: 'approve' | 'deny', code: string, remember?: string, durationMs?: number) => {
    const params = new URLSearchParams({ code });
    if (remember) params.set('remember', remember);
    if (durationMs) params.set('duration_ms', String(durationMs));
    return post<unknown>(`/${action}?${params}`);
  },
  approvalPreview: (id: string) =>
    post<Record<string, unknown>>(`/approval-preview/${encodeURIComponent(id)}`),
  chat: (messages: ChatMessage[]) =>
    post<{ messages: ChatMessage[]; proposals: Proposal[] }>('/api/assistant/chat', { messages }),
};
