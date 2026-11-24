import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from './api';
import type {
  ActivityEvent,
  Grant,
  GrantOption,
  Meta,
  PendingApproval,
  PlanCall,
  State,
  Status,
  ThemePreference,
  Tool,
  ToolTier,
} from './types';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface RevealedKey {
  agentId: string;
  key: string;
  rotated?: boolean;
}

export type LiveConnectionState = 'live' | 'reconnecting' | 'readonly';

interface Store {
  state: State | null;
  meta: Meta | null;
  status: Status | null;
  tools: Tool[];
  toolErrors: string[];
  toolsLoaded: boolean;
  toolsLoading: boolean;
  pending: PendingApproval[];
  grants: Grant[];
  canRevokeGrants: boolean;
  activity: ActivityEvent[];
  liveState: LiveConnectionState;
  eventTick: number;
  loadError: string | null;
  setState: (state: State) => void;
  refreshState: () => Promise<void>;
  refreshTools: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshPending: () => Promise<void>;
  refreshGrants: () => Promise<void>;
  revokeGrant: (id: string) => Promise<void>;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;
  revealed: RevealedKey[];
  reveal: (keys: RevealedKey[]) => void;
  dismissReveal: () => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

const StoreContext = createContext<Store | null>(null);
const THEME_KEY = 'airlock:theme';

function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // ignore storage failures
  }
  return 'system';
}

function applyTheme(theme: ThemePreference) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreProvider missing');
  return store;
}

export function StoreProvider({ children }: { children: ComponentChildren }) {
  const [state, setState] = useState<State | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolErrors, setToolErrors] = useState<string[]>([]);
  const [toolsLoaded, setToolsLoaded] = useState(false);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [canRevokeGrants, setCanRevokeGrants] = useState(false);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [liveState, setLiveState] = useState<LiveConnectionState>('readonly');
  const [eventTick, setEventTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [revealed, setRevealed] = useState<RevealedKey[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [theme, setThemeState] = useState<ThemePreference>(readStoredTheme);
  const toastId = useRef(0);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((list) => [...list, { id, text, tone }]);
    setTimeout(
      () => setToasts((list) => list.filter((t) => t.id !== id)),
      tone === 'error' ? 7000 : 3200
    );
  }, []);

  const refreshState = useCallback(async () => setState(await api.state()), []);
  const refreshStatus = useCallback(async () => setStatus(await api.status()), []);
  const refreshTools = useCallback(async () => {
    setToolsLoading(true);
    try {
      const result = await api.tools();
      // airlock/* tools (approvals, questions) are granted by the gateway itself, not by rules.
      setTools((result.tools ?? []).filter((tool) => tool.provider !== 'airlock'));
      setToolErrors(result.errors ?? []);
      setToolsLoaded(true);
    } finally {
      setToolsLoading(false);
    }
  }, []);

  const refreshGrants = useCallback(async () => {
    try {
      const result = await api.grants();
      setGrants(result.grants ?? []);
      setCanRevokeGrants(result.canRevoke !== false);
    } catch {
      // Older or restricted endpoints may not expose grants.
    }
  }, []);

  const revokeGrant = useCallback(
    async (id: string) => {
      try {
        await api.revokeGrant(id);
        setGrants((list) => list.filter((g) => g.id !== id));
        toast('Grant revoked');
        refreshGrants().catch(() => {});
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [toast, refreshGrants]
  );

  const refreshPending = useCallback(async () => {
    const [logs, events] = await Promise.all([api.logs({ limit: '1' }), api.activity()]);
    const incoming = (logs.pending ?? []).map(normalizePending);
    setPending((prev) => {
      const byId = new Map(prev.map((item) => [item.id, item]));
      return incoming.map((item) => {
        const live = byId.get(item.id);
        if (!live) return item;
        return {
          ...item,
          expiresAt: item.expiresAt ?? live.expiresAt,
          timeoutMs: item.timeoutMs || live.timeoutMs,
          grantOptions: item.grantOptions ?? live.grantOptions,
          batchId: item.batchId ?? live.batchId,
          batchCode: item.batchCode ?? live.batchCode,
          batchSize: item.batchSize ?? live.batchSize,
          tier: item.tier ?? live.tier,
          provider: item.provider ?? live.provider,
          escalated: item.escalated ?? live.escalated,
          mode: item.mode ?? live.mode,
          plan: item.plan ?? live.plan,
        };
      });
    });
    setActivity((prev) => (events.events?.length ? events.events : prev));
  }, []);

  useEffect(() => {
    Promise.all([refreshState(), api.meta().then(setMeta)])
      .then(() => {
        refreshStatus().catch(() => {});
        refreshTools().catch((e) => toast(`Could not load tools: ${e.message}`, 'error'));
        refreshPending().catch(() => {});
        refreshGrants().catch(() => {});
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  // Periodic expiry cleanup / refresh for grants so expired ones drop cleanly.
  useEffect(() => {
    const timer = setInterval(() => {
      refreshGrants().catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [refreshGrants]);

  // Live approvals. The server pushes new and resolved requests; reconnect with backoff. A command
  // center without approval routes has no stream, so don't knock on it forever.
  const liveApprovals = meta?.approvals === true;
  useEffect(() => {
    if (!liveApprovals || !('EventSource' in window)) {
      setLiveState('readonly');
      return;
    }
    let source: EventSource | null = null;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      source = new EventSource('/events');
      source.onopen = () => {
        retry = 1000;
        setLiveState('live');
      };
      source.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'new' && message.request?.id) {
          const request = normalizePending(message.request);
          setPending((list) => [request, ...list.filter((p) => p.id !== request.id)]);
          setEventTick((t) => t + 1);
          notify(`${request.agentId} wants ${request.tool}`, request.reason ?? '');
        } else if (message.type === 'resolved') {
          setPending((list) => list.filter((p) => p.id !== message.id && p.code !== message.code));
          setEventTick((t) => t + 1);
          refreshGrants().catch(() => {});
        } else if (message.type === 'activity' && message.event?.id) {
          setActivity((list) =>
            [message.event, ...list.filter((e) => e.id !== message.event.id)].slice(0, 200)
          );
          setEventTick((t) => t + 1);
        }
      };
      source.onerror = () => {
        setLiveState('reconnecting');
        source?.close();
        timer = setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
      };
    };
    connect();
    return () => {
      clearTimeout(timer);
      source?.close();
    };
  }, [liveApprovals, refreshGrants]);

  const store = useMemo<Store>(
    () => ({
      state,
      meta,
      status,
      tools,
      toolErrors,
      toolsLoaded,
      toolsLoading,
      pending,
      grants,
      canRevokeGrants,
      activity,
      liveState,
      eventTick,
      loadError,
      setState,
      refreshState,
      refreshTools,
      refreshStatus,
      refreshPending,
      refreshGrants,
      revokeGrant,
      toasts,
      toast,
      revealed,
      reveal: (keys) => setRevealed(keys),
      dismissReveal: () => setRevealed([]),
      assistantOpen,
      setAssistantOpen,
      theme,
      setTheme,
    }),
    [
      state,
      meta,
      status,
      tools,
      toolErrors,
      toolsLoaded,
      toolsLoading,
      pending,
      grants,
      canRevokeGrants,
      activity,
      liveState,
      eventTick,
      loadError,
      toasts,
      revealed,
      assistantOpen,
      theme,
      setTheme,
      refreshGrants,
      revokeGrant,
    ]
  );

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function notify(title: string, body: string) {
  try {
    if (localStorage.getItem('airlock:notifs') !== 'true') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(`Airlock: ${title}`, { body });
  } catch {
    // Notifications are a convenience; ignore storage or permission failures.
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse errors
    }
  }
  return {};
}

function normalizePlanCalls(raw: unknown): PlanCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: PlanCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const tool = typeof entry.tool === 'string' ? entry.tool : '';
    if (!tool) continue;
    const rawArgs = entry.args ?? entry.arguments;
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    calls.push({ tool, args });
  }
  return calls.length > 0 ? calls : undefined;
}

export function normalizePending(raw: unknown): PendingApproval {
  const request = (raw ?? {}) as Record<string, unknown>;
  let args = request.args as unknown;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { value: args };
    }
  }
  const record =
    args && typeof args === 'object' && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};

  // Stored SQLite rows (and remote proxies) pack extra fields into `meta`.
  const meta = parseJsonObject(request.meta);
  const subject = parseJsonObject(meta.subject);

  // Live events carry the agent's reason in `context`; stored rows keep it inside the args.
  const context = (request.context ?? record._airlock ?? {}) as Record<string, unknown>;
  delete record._airlock;

  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  const tool = String(request.tool ?? '');
  const rawKind = text(request.kind) ?? text(meta.kind);
  const kind: PendingApproval['kind'] =
    rawKind === 'plan' || rawKind === 'question' || rawKind === 'call'
      ? rawKind
      : tool === 'airlock/request_approval'
        ? 'plan'
        : tool === 'airlock/ask_user'
          ? 'question'
          : 'call';

  const rawMode = text(request.mode) ?? text(meta.mode);
  const mode = rawMode === 'sync' || rawMode === 'async' ? rawMode : undefined;

  const rawTier = text(request.tier) ?? text(subject.tier);
  const tier =
    rawTier === 'read' || rawTier === 'write' || rawTier === 'destructive'
      ? (rawTier as ToolTier)
      : undefined;

  const provider =
    text(request.provider) ??
    text(subject.provider) ??
    (tool.includes('/') && !tool.startsWith('airlock/') ? tool.split('/')[0] : undefined);

  const escalated =
    typeof request.escalated === 'boolean'
      ? request.escalated
      : typeof subject.escalated === 'boolean'
        ? subject.escalated
        : undefined;

  const plan =
    normalizePlanCalls(request.plan) ??
    normalizePlanCalls(meta.plan) ??
    (kind === 'plan' ? normalizePlanCalls(record.calls) : undefined);

  const rawGrantOptions = Array.isArray(request.grantOptions)
    ? request.grantOptions
    : Array.isArray(meta.grantOptions)
      ? meta.grantOptions
      : undefined;
  const grantOptions = rawGrantOptions as GrantOption[] | undefined;

  const createdAt = String(request.createdAt ?? request.created_at ?? new Date().toISOString());
  const timeoutMs = Number(request.timeoutMs ?? 0);
  const expiresAt =
    text(request.expiresAt) ??
    text(meta.expiresAt) ??
    (timeoutMs > 0 && !Number.isNaN(Date.parse(createdAt))
      ? new Date(Date.parse(createdAt) + timeoutMs).toISOString()
      : undefined);

  const reason = text(context.reason) ?? (kind === 'plan' ? text(record.reason) : undefined);
  const note = text(context.note);

  return {
    id: String(request.id ?? ''),
    code: String(request.code ?? ''),
    agentId: String(request.agentId ?? request.agent_id ?? ''),
    tool,
    args: record,
    reason,
    note,
    createdAt,
    expiresAt,
    timeoutMs,
    kind,
    mode,
    tier,
    provider,
    escalated,
    plan,
    grantOptions,
    batchId: text(request.batchId) ?? text(meta.batchId),
    batchCode: text(request.batchCode) ?? text(meta.batchCode),
    batchSize: typeof request.batchSize === 'number' ? request.batchSize : undefined,
  };
}

// Minimal hash router: #/overview, #/approvals, #/grants, #/agents, #/agents/new, #/agents/:id, ...
export function useRoute(): string[] {
  const read = () =>
    window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    let current = window.location.hash;
    const onChange = () => {
      if (skipGuard) {
        skipGuard = false;
      } else if (unsaved.size > 0) {
        if (!window.confirm(LEAVE_MESSAGE)) {
          skipGuard = true;
          window.location.hash = current;
          return;
        }
        unsaved.clear();
      }
      current = window.location.hash;
      setRoute(read());
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (unsaved.size > 0) e.preventDefault();
    };
    window.addEventListener('hashchange', onChange);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);
  return route;
}

const LEAVE_MESSAGE = 'Leave this page? Your unsaved changes will be lost.';
const unsaved = new Set<symbol>();
let skipGuard = false;

export function useUnsavedGuard(dirty: boolean) {
  const token = useRef(Symbol('unsaved'));
  useEffect(() => {
    if (dirty) unsaved.add(token.current);
    else unsaved.delete(token.current);
    return () => {
      unsaved.delete(token.current);
    };
  }, [dirty]);
}

export function go(...parts: string[]) {
  window.location.hash = '/' + parts.map(encodeURIComponent).join('/');
}

export function goAfterSave(...parts: string[]) {
  unsaved.clear();
  skipGuard = window.location.hash !== '#/' + parts.map(encodeURIComponent).join('/');
  go(...parts);
}
