import { useEffect, useMemo, useState } from 'preact/hooks';
import { Activity as ActivityIcon, Bell, BellOff, RotateCw } from 'lucide-preact';
import { api } from './api';
import { useStore } from './store';
import type { AuditEntry } from './types';
import {
  ArgsTable,
  Button,
  Empty,
  SearchInput,
  ToolCode,
  clockTime,
  cx,
  formatDuration,
  fullTime,
  plural,
  relativeTime,
} from './ui';

type Bucket = 'all' | 'allowed' | 'approval' | 'denied' | 'error';

export function auditBucket(result: string): Exclude<Bucket, 'all'> {
  const lower = result.toLowerCase();
  if (/error|timeout|disconnected|canary/.test(lower)) return 'error';
  if (/denied|injection|blocked/.test(lower)) return 'denied';
  if (/hitl|ask|pending|plan/.test(lower)) return 'approval';
  return 'allowed';
}

const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'allowed', label: 'Allowed' },
  { id: 'approval', label: 'Approvals' },
  { id: 'denied', label: 'Denied' },
  { id: 'error', label: 'Errors' },
];

const DOT: Record<Exclude<Bucket, 'all'>, string> = {
  allowed: 'is-allow',
  approval: 'is-ask',
  denied: 'is-deny',
  error: 'is-deny',
};

const RESULT_LABEL: Record<string, string> = {
  allowed: 'Allowed',
  denied: 'Denied',
  hitl_approved: 'Approved',
  hitl_denied: 'Rejected',
  injection_blocked: 'Injection blocked',
  error: 'Error',
};

function resultLabel(result: string): string {
  if (RESULT_LABEL[result]) return RESULT_LABEL[result];
  const text = result.replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function Activity() {
  const { state, pending, activity, eventTick } = useStore();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [dbPath, setDbPath] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [agent, setAgent] = useState('');
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState<Bucket>('all');
  const [loading, setLoading] = useState(false);
  const [allNotes, setAllNotes] = useState(false);

  const load = () => {
    setLoading(true);
    return api
      .logs({ agent, limit: '250' })
      .then((result) => {
        setEntries(result.entries ?? []);
        setDbPath(result.dbPath);
        setAuditError(result.error ?? null);
      })
      .catch((e) => setAuditError(e.message))
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  };

  // Reload when the agent filter changes or a live event arrives.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 120);
    return () => clearTimeout(timer);
  }, [agent, eventTick, pending.length]);

  const q = query.trim().toLowerCase();
  const searched = useMemo(() => {
    if (!q) return entries;
    return entries.filter((entry) =>
      `${entry.tool} ${entry.agent_id} ${entry.result} ${entry.hitl_code ?? ''} ${entry.error ?? ''} ${
        typeof entry.args === 'string' ? entry.args : JSON.stringify(entry.args ?? '')
      }`
        .toLowerCase()
        .includes(q)
    );
  }, [entries, q]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = {
      all: searched.length,
      allowed: 0,
      approval: 0,
      denied: 0,
      error: 0,
    };
    for (const entry of searched) c[auditBucket(entry.result)] += 1;
    return c;
  }, [searched]);

  const visible =
    bucket === 'all' ? searched : searched.filter((e) => auditBucket(e.result) === bucket);
  const notes = activity.filter((e) => !agent || e.agentId === agent);
  const shownNotes = allNotes ? notes.slice(0, 20) : notes.slice(0, 3);
  const agentOptions = Array.from(
    new Set([...Object.keys(state?.agents ?? {}), ...entries.map((e) => e.agent_id)])
  ).sort();
  const waiting = pending.filter((p) => !agent || p.agentId === agent).length;

  return (
    <>
      <header class="topbar">
        <div class="topbar-title">
          <h1>Activity</h1>
          <span class="topbar-meta">
            {loaded ? plural(entries.length, 'call') : 'Loading…'}
            {waiting > 0 && (
              <>
                <span class="sep">·</span>
                <a class="link" href="#/inbox">
                  {waiting} waiting in Inbox
                </a>
              </>
            )}
          </span>
        </div>
        <div class="topbar-actions">
          <NotifyToggle />
          <Button
            variant="ghost"
            icon
            busy={loading}
            aria-label="Refresh activity"
            title="Refresh"
            onClick={() => void load()}
          >
            <RotateCw size={14} aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div class="page">
        {notes.length > 0 && (
          <section aria-label="Agent notes">
            <h2 class="section-label">
              Agent notes <span class="ink-3">{notes.length}</span>
            </h2>
            <ul class="notes">
              {shownNotes.map((n) => (
                <li key={n.id} class="note">
                  <span
                    class={cx(
                      'dot',
                      n.severity === 'error'
                        ? 'is-deny'
                        : n.severity === 'warning'
                          ? 'is-ask'
                          : n.severity === 'success'
                            ? 'is-allow'
                            : ''
                    )}
                    aria-hidden="true"
                  />
                  <span class="note-title">{n.title}</span>
                  <span class="note-meta" title={fullTime(n.createdAt)}>
                    {n.agentId} · {relativeTime(n.createdAt)}
                  </span>
                  {n.body && <span class="note-body">{n.body}</span>}
                </li>
              ))}
            </ul>
            {notes.length > 3 && (
              <button
                type="button"
                class="text-btn"
                style={{ margin: '-18px 0 28px' }}
                onClick={() => setAllNotes(!allNotes)}
              >
                {allNotes ? 'Show fewer notes' : `Show ${notes.length - 3} more`}
              </button>
            )}
          </section>
        )}

        <div class="toolbar">
          <div class="segmented" role="tablist" aria-label="Filter by result">
            {BUCKETS.map((b) => (
              <button
                key={b.id}
                type="button"
                role="tab"
                aria-selected={bucket === b.id}
                onClick={() => setBucket(b.id)}
              >
                {b.label}
                <span class="seg-count">{counts[b.id]}</span>
              </button>
            ))}
          </div>
          <span class="toolbar-spacer" />
          {agentOptions.length > 1 && (
            <select
              class="select"
              value={agent}
              onChange={(e) => setAgent(e.currentTarget.value)}
              aria-label="Filter by agent"
            >
              <option value="">All agents</option>
              {agentOptions.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
          <SearchInput
            value={query}
            onInput={setQuery}
            placeholder="Search tool, args, code"
            label="Search activity"
          />
        </div>

        {auditError && (
          <p class="notice is-warn" style={{ marginBottom: '16px' }}>
            {auditError}
          </p>
        )}

        {!loaded ? (
          <div aria-busy="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ padding: '12px 4px', borderBottom: '1px solid var(--line)' }}>
                <span class="skeleton" style={{ width: `${60 - i * 7}%` }} />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <Empty
            title={entries.length === 0 ? 'No tool calls yet' : 'No calls match these filters'}
            icon={<ActivityIcon size={22} aria-hidden="true" />}
          >
            {entries.length > 0 ? (
              <Button
                size="sm"
                onClick={() => {
                  setQuery('');
                  setBucket('all');
                  setAgent('');
                }}
              >
                Clear filters
              </Button>
            ) : (
              dbPath && (
                <p>
                  Reading <code>{dbPath}</code>
                </p>
              )
            )}
          </Empty>
        ) : (
          <div class="table-scroll">
            <table class="log">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Result</th>
                  <th scope="col" class="hide-sm">
                    Agent
                  </th>
                  <th scope="col">Tool</th>
                  <th scope="col" class="col-num hide-sm">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry, i) => (
                  <LogRow key={entry.id ?? `${entry.ts}-${i}`} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function NotifyToggle() {
  const read = () => {
    try {
      return (
        localStorage.getItem('airlock:notifs') === 'true' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      );
    } catch {
      return false;
    }
  };
  const [on, setOn] = useState(read);
  if (!('Notification' in window)) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={on}
      title={on ? 'Desktop alerts are on' : 'Get a desktop alert for new requests'}
      onClick={async () => {
        const want = !on;
        const granted = want && (await Notification.requestPermission()) === 'granted';
        try {
          localStorage.setItem('airlock:notifs', String(granted));
        } catch {
          // Without storage the toggle lasts for this page only.
        }
        setOn(granted);
      }}
    >
      {on ? <Bell size={14} aria-hidden="true" /> : <BellOff size={14} aria-hidden="true" />}
      {on ? 'Alerts on' : 'Alerts off'}
    </Button>
  );
}

function LogRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const bucket = auditBucket(entry.result);
  const tone = bucket === 'error' || /injection/.test(entry.result) ? 'is-bad' : '';
  const toggle = () => setOpen(!open);
  return (
    <>
      <tr
        class={cx('row', open && 'is-open')}
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <td class="col-time" title={fullTime(entry.ts)}>
          {clockTime(entry.ts)}
        </td>
        <td class="col-result">
          <span class={cx('result', tone)}>
            <span class={cx('dot', DOT[bucket])} aria-hidden="true" />
            {resultLabel(entry.result)}
          </span>
        </td>
        <td class="col-agent hide-sm">{entry.agent_id}</td>
        <td class="col-tool">
          <ToolCode tool={entry.tool} />
          {entry.error && !open && <span class="err">{entry.error}</span>}
        </td>
        <td class="col-num hide-sm">
          {entry.duration_ms != null ? formatDuration(entry.duration_ms) : '—'}
        </td>
      </tr>
      {open && (
        <tr class="log-detail">
          <td colSpan={5}>
            <div class="log-detail-inner">
              <div class="log-facts">
                <span>{fullTime(entry.ts)}</span>
                <span>
                  Agent <code>{entry.agent_id}</code>
                </span>
                {entry.hitl_code && (
                  <span>
                    Approval <code>{entry.hitl_code}</code>
                  </span>
                )}
                {entry.request_id && (
                  <span>
                    Request <code>{entry.request_id}</code>
                  </span>
                )}
                {entry.duration_ms != null && (
                  <span>
                    Took <code>{formatDuration(entry.duration_ms)}</code>
                  </span>
                )}
              </div>
              {entry.error && <p class="notice is-error">{entry.error}</p>}
              <ArgsTable value={entry.args} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
