import { useEffect, useState } from 'preact/hooks';
import { api } from './api';
import { useStore } from './store';
import type { AuditEntry, PendingApproval } from './types';
import { Button, Empty, Sheet, cx, relativeTime } from './ui';

function isQuestion(p: PendingApproval) {
  return p.tool === 'airlock/ask_user';
}

function questionText(p: PendingApproval) {
  const value = p.args.question ?? p.args.title ?? p.args.message;
  return typeof value === 'string' && value.trim() ? value.trim() : 'Question from agent';
}

function pretty(value: unknown): string {
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(String(value)), null, 2);
  } catch {
    return String(value ?? '');
  }
}

export function Activity() {
  const { state, pending, activity, refreshPending, refreshStatus, toast } = useStore();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [dbPath, setDbPath] = useState('');
  const [auditError, setAuditError] = useState<string | null>(null);
  const [agent, setAgent] = useState('');
  const [tool, setTool] = useState('');
  const [open, setOpen] = useState<PendingApproval | null>(null);

  const load = () =>
    api
      .logs({ agent, tool, limit: '100' })
      .then((result) => {
        setEntries(result.entries ?? []);
        setDbPath(result.dbPath);
        setAuditError(result.error ?? null);
      })
      .catch((e) => setAuditError(e.message));

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [agent, tool, pending.length]);

  const decide = async (
    p: PendingApproval,
    action: 'approve' | 'deny',
    remember?: string,
    durationMs?: number
  ) => {
    try {
      await api.decide(action, p.code, remember, durationMs);
      setOpen(null);
      toast(action === 'approve' ? `Approved ${p.tool}` : `Denied ${p.tool}`);
      await Promise.all([refreshPending(), refreshStatus()]);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // a / d act on the open request, or the oldest waiting one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const subject = open ?? pending[pending.length - 1];
      if (!subject) return;
      if (e.key === 'a') decide(subject, 'approve');
      if (e.key === 'd') decide(subject, 'deny');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const visiblePending = pending.filter((p) => !agent || p.agentId === agent);
  const notes = activity.filter((e) => !agent || e.agentId === agent).slice(0, 20);

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Activity</h1>
          <p class="lede">Requests waiting for you, and everything agents did recently.</p>
        </div>
        <div class="page-actions filters">
          <NotifyToggle />
          <select
            value={agent}
            onChange={(e) => setAgent(e.currentTarget.value)}
            aria-label="Agent"
          >
            <option value="">All agents</option>
            {Object.keys(state?.agents ?? {}).map((id) => (
              <option value={id}>{id}</option>
            ))}
          </select>
          <input
            type="search"
            class="search"
            placeholder="Filter by tool"
            value={tool}
            onInput={(e) => setTool(e.currentTarget.value)}
            aria-label="Filter by tool"
          />
        </div>
      </header>

      <section class="waiting-section">
        <h2 class="section-title">
          Waiting for you{' '}
          <span class={cx('count', visiblePending.length > 0 && 'is-hot')}>
            {visiblePending.length}
          </span>
        </h2>
        {visiblePending.length === 0 ? (
          <p class="hint">Nothing is waiting. New requests appear here the moment an agent asks.</p>
        ) : (
          <ul class="requests">
            {visiblePending.map((p) => (
              <li class="request" key={p.id}>
                <button type="button" class="request-body" onClick={() => setOpen(p)}>
                  <span class="request-agent">{p.agentId}</span>
                  <code class="request-tool">{isQuestion(p) ? questionText(p) : p.tool}</code>
                  {p.tier && p.tier !== 'read' && (
                    <span class={cx('tag', `tag-tier-${p.tier}`)}>{p.tier}</span>
                  )}
                  {p.reason && <span class="request-reason">{p.reason}</span>}
                  <span class="request-time">{relativeTime(p.createdAt)}</span>
                </button>
                <div class="request-actions">
                  <Button size="sm" variant="primary" onClick={() => decide(p, 'approve')}>
                    {isQuestion(p) ? 'Confirm' : 'Approve'}
                  </Button>
                  {!isQuestion(p) && (
                    <Button size="sm" onClick={() => decide(p, 'approve', 'temporary', 3_600_000)}>
                      Allow for 1 hour
                    </Button>
                  )}
                  <Button size="sm" variant="danger" onClick={() => decide(p, 'deny')}>
                    Deny
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {visiblePending.length > 0 && (
          <p class="kbd-hint">
            <kbd>A</kbd> approves and <kbd>D</kbd> denies the oldest request
          </p>
        )}
      </section>

      {notes.length > 0 && (
        <section>
          <h2 class="section-title">Notes from agents</h2>
          <ul class="notes">
            {notes.map((n) => (
              <li key={n.id} class={cx('note', `is-${n.severity}`)}>
                <strong>{n.title}</strong>
                <span>{n.body}</span>
                <span class="dim">
                  {n.agentId}, {relativeTime(n.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 class="section-title">History</h2>
        {auditError && <p class="notice notice-warn">{auditError}</p>}
        {entries.length === 0 ? (
          <Empty title="No calls yet">{dbPath && <p class="dim">Reading {dbPath}</p>}</Empty>
        ) : (
          <table class="audit">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Agent</th>
                <th scope="col">Tool</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <AuditRow key={entry.id ?? i} entry={entry} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {open && <ApprovalSheet request={open} onClose={() => setOpen(null)} onDecide={decide} />}
    </div>
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
    <label class="check notify-toggle">
      <input
        type="checkbox"
        checked={on}
        onChange={async (e) => {
          const want = e.currentTarget.checked;
          const granted = want && (await Notification.requestPermission()) === 'granted';
          try {
            localStorage.setItem('airlock:notifs', String(granted));
          } catch {
            // Without storage the toggle lasts for this page only.
          }
          setOn(granted);
        }}
      />
      Notify me
    </label>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const tone = /denied|error|timeout/.test(entry.result)
    ? 'bad'
    : /hitl|ask/.test(entry.result)
      ? 'warn'
      : 'good';
  return (
    <>
      <tr class={cx('audit-row', expanded && 'is-open')} onClick={() => setExpanded(!expanded)}>
        <td title={new Date(entry.ts).toLocaleString()}>{relativeTime(entry.ts)}</td>
        <td>{entry.agent_id}</td>
        <td>
          <code>{entry.tool}</code>
        </td>
        <td>
          <span class={cx('result', `is-${tone}`)}>{entry.result.replace(/_/g, ' ')}</span>
          {entry.duration_ms ? <span class="dim"> {entry.duration_ms} ms</span> : null}
        </td>
      </tr>
      {expanded && (
        <tr class="audit-detail">
          <td colSpan={4}>
            <pre>{pretty(entry.args)}</pre>
            {entry.error && <p class="notice notice-error">{entry.error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function ApprovalSheet({
  request,
  onClose,
  onDecide,
}: {
  request: PendingApproval;
  onClose: () => void;
  onDecide: (
    p: PendingApproval,
    action: 'approve' | 'deny',
    remember?: string,
    durationMs?: number
  ) => void;
}) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const question = isQuestion(request);

  useEffect(() => {
    if (question) return;
    let live = true;
    api.approvalPreview(request.id).then(
      (result) => live && setPreview(result),
      (e) =>
        live &&
        !String(e.message).includes('Not Found') &&
        e.status !== 404 &&
        setPreviewError(e.message)
    );
    return () => {
      live = false;
    };
  }, [request.id]);

  const fields = Array.isArray(preview?.fields)
    ? (preview!.fields as { label: string; value: string; primary?: boolean }[])
    : [];

  return (
    <Sheet
      open
      onClose={onClose}
      title={question ? questionText(request) : <code>{request.tool}</code>}
      footer={
        <>
          <Button variant="danger" onClick={() => onDecide(request, 'deny')}>
            Deny
          </Button>
          {!question && (
            <Button onClick={() => onDecide(request, 'approve', 'always')}>Always allow</Button>
          )}
          {!question && (
            <Button onClick={() => onDecide(request, 'approve', 'temporary', 3_600_000)}>
              Allow for 1 hour
            </Button>
          )}
          <Button variant="primary" onClick={() => onDecide(request, 'approve')}>
            {question ? 'Confirm' : 'Approve'}
          </Button>
        </>
      }
    >
      <dl class="facts">
        <dt>Agent</dt>
        <dd>{request.agentId}</dd>
        <dt>Asked</dt>
        <dd>{new Date(request.createdAt).toLocaleString()}</dd>
        {request.reason && (
          <>
            <dt>Reason given</dt>
            <dd>{request.reason}</dd>
          </>
        )}
        {request.note && (
          <>
            <dt>Note</dt>
            <dd>{request.note}</dd>
          </>
        )}
      </dl>
      {preview?.status === 'ready' && (
        <section class="fetched">
          {fields.length ? (
            <dl class="facts">
              {fields.map((f) => (
                <>
                  <dt>{f.label}</dt>
                  <dd class={cx(f.primary && 'is-primary')}>{f.value}</dd>
                </>
              ))}
            </dl>
          ) : (
            <pre class="fetched-text">{String(preview.text ?? '')}</pre>
          )}
          <p class="dim">
            Fetched with {String(preview.tool)}
            {preview.truncated ? ', truncated' : ''}
          </p>
        </section>
      )}
      {preview && preview.status !== 'ready' && preview.status !== 'unavailable' && (
        <p class="notice notice-warn">{String(preview.message ?? 'Preview unavailable.')}</p>
      )}
      {previewError && <p class="notice notice-warn">{previewError}</p>}
      <h3 class="sub-title">Arguments</h3>
      <pre class="args">{pretty(request.args)}</pre>
    </Sheet>
  );
}
