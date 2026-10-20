import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from './api';
import type { ActivityEvent, Meta, PendingApproval, State, Status, Tool } from './types';

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

interface Store {
  state: State | null;
  meta: Meta | null;
  status: Status | null;
  tools: Tool[];
  toolErrors: string[];
  toolsLoaded: boolean;
  toolsLoading: boolean;
  pending: PendingApproval[];
  activity: ActivityEvent[];
  loadError: string | null;
  setState: (state: State) => void;
  refreshState: () => Promise<void>;
  refreshTools: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshPending: () => Promise<void>;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;
  revealed: RevealedKey[];
  reveal: (keys: RevealedKey[]) => void;
  dismissReveal: () => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
}

const StoreContext = createContext<Store | null>(null);

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
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [revealed, setRevealed] = useState<RevealedKey[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const toastId = useRef(0);

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
  const refreshPending = useCallback(async () => {
    const [logs, events] = await Promise.all([api.logs({ limit: '1' }), api.activity()]);
    setPending((logs.pending ?? []).map(normalizePending));
    setActivity(events.events ?? []);
  }, []);

  useEffect(() => {
    Promise.all([refreshState(), api.meta().then(setMeta)])
      .then(() => {
        refreshStatus().catch(() => {});
        refreshTools().catch((e) => toast(`Could not load tools: ${e.message}`, 'error'));
        refreshPending().catch(() => {});
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  // Live approvals. The server pushes new and resolved requests; reconnect with backoff.
  useEffect(() => {
    if (!('EventSource' in window)) return;
    let source: EventSource | null = null;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      source = new EventSource('/events');
      source.onopen = () => (retry = 1000);
      source.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'new' && message.request?.id) {
          const request = normalizePending(message.request);
          setPending((list) => [request, ...list.filter((p) => p.id !== request.id)]);
          notify(`${request.agentId} wants ${request.tool}`, request.reason ?? '');
        } else if (message.type === 'resolved') {
          setPending((list) => list.filter((p) => p.id !== message.id && p.code !== message.code));
        } else if (message.type === 'activity' && message.event?.id) {
          setActivity((list) =>
            [message.event, ...list.filter((e) => e.id !== message.event.id)].slice(0, 200)
          );
        }
      };
      source.onerror = () => {
        source?.close();
        timer = setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
      };
    };
    connect();
    return () => {
      clearTimeout(timer);
      source?.close();
    };
  }, []);

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
      activity,
      loadError,
      setState,
      refreshState,
      refreshTools,
      refreshStatus,
      refreshPending,
      toasts,
      toast,
      revealed,
      reveal: (keys) => setRevealed(keys),
      dismissReveal: () => setRevealed([]),
      assistantOpen,
      setAssistantOpen,
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
      activity,
      loadError,
      toasts,
      revealed,
      assistantOpen,
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
  // Live events carry the agent's reason in `context`; stored rows keep it inside the args.
  const context = (request.context ?? record._airlock ?? {}) as Record<string, unknown>;
  delete record._airlock;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  return {
    id: String(request.id ?? ''),
    code: String(request.code ?? ''),
    agentId: String(request.agentId ?? request.agent_id ?? ''),
    tool: String(request.tool ?? ''),
    args: record,
    reason: text(context.reason),
    note: text(context.note),
    // Live events have no timestamp; they arrive as they are created.
    createdAt: String(request.createdAt ?? request.created_at ?? new Date().toISOString()),
    timeoutMs: Number(request.timeoutMs ?? 0),
    tier: text(request.tier) as PendingApproval['tier'],
  };
}

// Minimal hash router: #/agents, #/agents/new, #/agents/:id, ...
export function useRoute(): string[] {
  const read = () =>
    window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    let current = window.location.hash;
    const onChange = () => {
      if (skipGuard) {
        // A programmatic move (restoring the address, or leaving after a save): no prompt, and
        // whatever registered unsaved work stays registered.
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

// Pages with work in progress register here so leaving them asks first.
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

// Navigate after the work was saved, without the unsaved-changes prompt.
export function goAfterSave(...parts: string[]) {
  unsaved.clear();
  skipGuard = window.location.hash !== '#/' + parts.map(encodeURIComponent).join('/');
  go(...parts);
}
