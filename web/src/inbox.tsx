import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ListOrdered,
  MessageCircleQuestion,
  RotateCw,
  ShieldAlert,
  Wrench,
} from 'lucide-preact';
import { api } from './api';
import { useStore } from './store';
import type { DecideOptions, PendingApproval } from './types';
import {
  ArgsTable,
  Button,
  Kbd,
  Menu,
  Notice,
  ToolCode,
  cx,
  formatArgScalar,
  formatCountdown,
  fullTime,
  plural,
  relativeTime,
  remainingFraction,
  summarizeArgs,
  useNow,
  type MenuItem,
} from './ui';

export function isPlan(p: PendingApproval): boolean {
  return p.kind === 'plan' || p.tool === 'airlock/request_approval';
}

export function isQuestion(p: PendingApproval): boolean {
  return p.kind === 'question' || p.tool === 'airlock/ask_user';
}

export function questionText(p: PendingApproval): string {
  const value = p.args.question ?? p.args.title ?? p.args.message;
  return typeof value === 'string' && value.trim() ? value.trim() : 'Question from agent';
}

function providerOf(p: PendingApproval): string | undefined {
  return p.provider ?? (p.tool.includes('/') ? p.tool.split('/')[0] : undefined);
}

interface GrantChoice {
  id: string;
  label: string;
  sub?: string;
  hint?: string;
  options: DecideOptions;
  toast: string;
  permanent?: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Scoped grants a routine call can be approved with. Plans, questions, and calls flagged by a
// detector only ever get a single approval.
export function buildGrantChoices(p: PendingApproval): GrantChoice[] {
  if (p.kind !== 'call' || isPlan(p) || isQuestion(p) || p.escalated) return [];
  const choices: GrantChoice[] = [
    {
      id: 'tool-15m',
      label: 'This tool for 15 minutes',
      sub: p.tool,
      options: { grantScope: 'tool', durationMs: 15 * MINUTE },
      toast: `Allowed ${p.tool} for 15m`,
    },
    {
      id: 'tool-1h',
      label: 'This tool for 1 hour',
      options: { grantScope: 'tool', durationMs: HOUR },
      toast: `Allowed ${p.tool} for 1h`,
    },
  ];

  if (!p.tool.startsWith('event:')) {
    const provider = providerOf(p);
    const tierOpt = p.grantOptions?.find((o) => o.scope === 'tier');
    const tier =
      tierOpt?.tier ?? (p.tier === 'read' ? 'read' : p.tier === 'write' ? 'write' : undefined);
    if (tier && provider) {
      choices.push({
        id: `tier-${tier}`,
        label:
          tier === 'read'
            ? `Read-only ${provider} tools for 1 hour`
            : `Non-destructive ${provider} tools for 1 hour`,
        options: { grantScope: 'tier', grantTier: tier, durationMs: HOUR },
        toast: `Allowed ${tier === 'read' ? 'read-only' : 'non-destructive'} ${provider} tools for 1h`,
      });
    }
    if (provider) {
      choices.push({
        id: 'provider-1h',
        label: `Every ${provider} tool for 1 hour`,
        sub: `${provider}/*`,
        options: { grantScope: 'provider', durationMs: HOUR },
        toast: `Allowed ${provider}/* for 1h`,
      });
    }
    for (const opt of p.grantOptions ?? []) {
      if (opt.scope === 'profile' && opt.profile) {
        choices.push({
          id: `profile-${opt.profile}`,
          label: `Profile ${opt.profile} for 1 hour`,
          options: { grantScope: 'profile', grantProfile: opt.profile, durationMs: HOUR },
          toast: `Allowed profile ${opt.profile} for 1h`,
        });
      }
    }
  }

  choices.push({
    id: 'always',
    label: 'Always allow',
    sub: 'Adds an allow rule to airlock.yaml',
    options: { remember: 'always' },
    toast: `Always allowing ${p.tool}`,
    permanent: true,
  });
  return choices;
}

function approveLabel(p: PendingApproval): string {
  if (isQuestion(p)) return 'Confirm';
  if (isPlan(p)) return 'Approve plan';
  return 'Approve once';
}

function denyLabel(p: PendingApproval): string {
  if (isQuestion(p)) return 'Decline';
  if (isPlan(p)) return 'Deny plan';
  return 'Deny';
}

export function useApprovalDecider() {
  const { refreshPending, refreshStatus, refreshGrants, toast } = useStore();
  const [busyId, setBusyId] = useState<string | null>(null);

  const decide = async (
    p: PendingApproval,
    action: 'approve' | 'deny',
    options: DecideOptions = {},
    successLabel?: string
  ): Promise<boolean> => {
    setBusyId(p.id);
    try {
      await api.decide(action, p.code, options);
      const subject = isPlan(p) ? 'plan' : isQuestion(p) ? 'question' : p.tool;
      toast(
        successLabel ??
          (action === 'deny'
            ? `Denied ${subject}`
            : isPlan(p)
              ? `Approved ${plural(p.plan?.length ?? 0, 'planned call')}`
              : `Approved ${subject}`)
      );
      await Promise.all([refreshPending(), refreshStatus(), refreshGrants()]);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusyId(null);
    }
  };

  return { decide, busyId };
}

function sortQueue(items: PendingApproval[]): PendingApproval[] {
  const key = (p: PendingApproval) =>
    Date.parse(p.expiresAt ?? '') || Date.parse(p.createdAt) + 1e12;
  return [...items].sort((a, b) => key(a) - key(b));
}

function KindIcon({ p }: { p: PendingApproval }) {
  if (p.escalated || p.tier === 'destructive') return <ShieldAlert size={15} aria-hidden="true" />;
  if (isPlan(p)) return <ListOrdered size={15} aria-hidden="true" />;
  if (isQuestion(p)) return <MessageCircleQuestion size={15} aria-hidden="true" />;
  return <Wrench size={15} aria-hidden="true" />;
}

function rowSubject(p: PendingApproval) {
  if (isPlan(p)) return <span>Plan of {plural(p.plan?.length ?? 0, 'call')}</span>;
  if (isQuestion(p)) return <span>{questionText(p)}</span>;
  return <ToolCode tool={p.tool} />;
}

function rowLine(p: PendingApproval) {
  const flag = p.escalated ? 'Flagged' : p.tier === 'destructive' ? 'Destructive' : null;
  let rest: string;
  if (isPlan(p)) {
    rest = p.reason ?? (p.plan ?? []).map((s) => s.tool).join(', ');
  } else if (isQuestion(p)) {
    rest = typeof p.args.context === 'string' ? p.args.context : 'Waiting for your answer';
  } else {
    rest = p.reason ?? (summarizeArgs(p.args, 2) || 'No arguments');
  }
  return (
    <>
      {flag && (
        <>
          <span class="q-flag">{flag}</span>
          <span class="sep">·</span>
        </>
      )}
      {rest}
    </>
  );
}

export function Inbox() {
  const { state, meta, pending, grants, refreshPending, refreshGrants } = useStore();
  const canDecide = meta?.approvals === true;
  const now = useNow(1000);
  const { decide, busyId } = useApprovalDecider();
  const [agent, setAgent] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const ordered = useMemo(
    () => sortQueue(pending.filter((p) => !agent || p.agentId === agent)),
    [pending, agent]
  );
  // Until a request is picked (or after the picked one resolves), fall back to the request at the
  // same position, so the next one slides into place after a decision.
  const lastIndex = useRef(0);
  const found = ordered.findIndex((p) => p.id === selectedId);
  const selectedIndex =
    found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, ordered.length - 1));
  const selected = ordered[selectedIndex] ?? null;

  useEffect(() => {
    if (selected) {
      lastIndex.current = selectedIndex;
      if (selected.id !== selectedId) setSelectedId(selected.id);
    } else {
      setMobileOpen(false);
    }
  }, [ordered, selected?.id]);

  const select = (index: number) => {
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, index))];
    if (!next) return;
    setSelectedId(next.id);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  const run = async (
    p: PendingApproval,
    action: 'approve' | 'deny',
    options?: DecideOptions,
    label?: string
  ) => {
    lastIndex.current = ordered.findIndex((item) => item.id === p.id);
    const ok = await decide(p, action, options, label);
    if (ok) setMobileOpen(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
        return;
      if (document.querySelector('.scrim, .menu')) return;
      if (!ordered.length) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        select(selectedIndex + 1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        select(selectedIndex - 1);
      } else if (e.key === 'Enter' && target.tagName !== 'BUTTON' && target.tagName !== 'A') {
        e.preventDefault();
        setMobileOpen(true);
      } else if (e.key === 'Escape' && mobileOpen) {
        setMobileOpen(false);
      } else if (canDecide && selected && busyId !== selected.id) {
        if (e.key === 'a') {
          e.preventDefault();
          void run(selected, 'approve');
        } else if (e.key === 'd') {
          e.preventDefault();
          void run(selected, 'deny');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const agentIds = Array.from(
    new Set([...Object.keys(state?.agents ?? {}), ...pending.map((p) => p.agentId)])
  ).sort();

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshPending(), refreshGrants()]);
    } finally {
      setRefreshing(false);
    }
  };

  const header = (
    <header class="topbar">
      <div class="topbar-title">
        <h1>Inbox</h1>
        <span class="topbar-meta">
          {ordered.length ? `${ordered.length} waiting` : 'Clear'}
          {grants.length > 0 && (
            <>
              <span class="sep">·</span>
              <a class="link" href="#/grants">
                {plural(grants.length, 'active grant')}
              </a>
            </>
          )}
        </span>
      </div>
      <div class="topbar-actions">
        <Button
          variant="ghost"
          icon
          busy={refreshing}
          aria-label="Refresh inbox"
          title="Refresh"
          onClick={refresh}
        >
          <RotateCw size={14} aria-hidden="true" />
        </Button>
      </div>
    </header>
  );

  if (pending.length === 0) {
    return (
      <div class="inbox-page">
        {header}
        <div class="inspector-empty" style={{ height: 'calc(100dvh - 53px)' }}>
          <InboxZero canDecide={canDecide} />
        </div>
      </div>
    );
  }

  return (
    <div class="inbox">
      <section class="queue" aria-label="Pending requests">
        {header}
        {agentIds.length > 1 && (
          <div class="queue-filter">
            <select
              class="select"
              value={agent}
              onChange={(e) => setAgent(e.currentTarget.value)}
              aria-label="Filter by agent"
            >
              <option value="">All agents</option>
              {agentIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        )}
        <div class="queue-list" ref={listRef} role="listbox" aria-label="Requests">
          {ordered.length === 0 ? (
            <div class="empty">
              <p class="empty-title">Nothing from {agent}</p>
              <Button size="sm" onClick={() => setAgent('')}>
                Show all agents
              </Button>
            </div>
          ) : (
            ordered.map((p, index) => {
              const countdown = formatCountdown(p.expiresAt, now);
              const fraction = remainingFraction(p.createdAt, p.expiresAt, now);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  data-id={p.id}
                  aria-selected={index === selectedIndex}
                  class={cx('q-row', (p.escalated || p.tier === 'destructive') && 'is-hot')}
                  onClick={() => {
                    setSelectedId(p.id);
                    setMobileOpen(true);
                  }}
                >
                  <span class="q-icon">
                    <KindIcon p={p} />
                  </span>
                  <span class="q-head">
                    <span class="q-agent">{p.agentId}</span>
                    <span class="q-subject">{rowSubject(p)}</span>
                  </span>
                  <span
                    class={cx('q-time', countdown?.urgent && 'is-urgent')}
                    title={p.expiresAt ? `Expires ${fullTime(p.expiresAt)}` : undefined}
                  >
                    {countdown ? countdown.label : relativeTime(p.createdAt, now)}
                  </span>
                  <span class="q-line">{rowLine(p)}</span>
                  {fraction !== null && (
                    <span class={cx('expiry', countdown?.urgent && 'is-urgent')} aria-hidden="true">
                      <span style={{ transform: `scaleX(${fraction})` }} />
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        {canDecide && (
          <footer class="queue-foot" aria-hidden="true">
            <span>
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> move
            </span>
            <span>
              <Kbd>A</Kbd> approve
            </span>
            <span>
              <Kbd>D</Kbd> deny
            </span>
            <span>
              <Kbd>?</Kbd> help
            </span>
          </footer>
        )}
      </section>

      <section
        class={cx('inspector', mobileOpen && 'is-open')}
        aria-label="Request details"
        aria-live="polite"
      >
        <div class="inspector-back">
          <Button variant="ghost" size="sm" onClick={() => setMobileOpen(false)}>
            <ArrowLeft size={14} aria-hidden="true" />
            Inbox
          </Button>
        </div>
        {selected ? (
          <Inspector
            key={selected.id}
            request={selected}
            now={now}
            canDecide={canDecide}
            busy={busyId === selected.id}
            onDecide={run}
          />
        ) : null}
      </section>
    </div>
  );
}

function InboxZero({ canDecide }: { canDecide: boolean }) {
  return (
    <div class="inbox-zero">
      <span class="brand-mark mark-lg" aria-hidden="true" />
      <p class="empty-title">Nothing waiting</p>
      <p>
        When an agent hits an ask rule, submits a plan, or asks you a question, it lands here
        instantly.
      </p>
      {canDecide ? (
        <div class="shortcut-row" aria-hidden="true">
          <span>
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move
          </span>
          <span>
            <Kbd>A</Kbd> approve
          </span>
          <span>
            <Kbd>D</Kbd> deny
          </span>
        </div>
      ) : (
        <p class="ink-3" style={{ marginTop: '8px' }}>
          This view is read-only. Decide from the gateway dashboard or the companion app.
        </p>
      )}
    </div>
  );
}

function Inspector({
  request,
  now,
  canDecide,
  busy,
  onDecide,
}: {
  request: PendingApproval;
  now: number;
  canDecide: boolean;
  busy: boolean;
  onDecide: (
    p: PendingApproval,
    action: 'approve' | 'deny',
    options?: DecideOptions,
    label?: string
  ) => void;
}) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const plan = isPlan(request);
  const question = isQuestion(request);
  const countdown = formatCountdown(request.expiresAt, now);
  const choices = canDecide ? buildGrantChoices(request) : [];

  useEffect(() => {
    if (question || plan || !canDecide) return;
    let live = true;
    api.approvalPreview(request.id).then(
      (result) => live && setPreview(result),
      (e) =>
        live &&
        e.status !== 404 &&
        !String(e.message).includes('Not Found') &&
        setPreviewError(e.message)
    );
    return () => {
      live = false;
    };
  }, [request.id, question, plan, canDecide]);

  const fields = Array.isArray(preview?.fields)
    ? (preview!.fields as { label: string; value: string; primary?: boolean }[])
    : [];

  const menuItems: MenuItem[] = choices.map((choice, i) => ({
    id: choice.id,
    label: choice.label,
    sub: choice.sub,
    hint: choice.hint,
    separatorBefore: choice.permanent && i > 0,
    onSelect: () => onDecide(request, 'approve', choice.options, choice.toast),
  }));

  return (
    <>
      <div class="inspector-scroll">
        <header class="inspector-head">
          <h2 class={cx('inspector-title', question && 'question-text')}>
            {question ? (
              questionText(request)
            ) : plan ? (
              `Plan of ${plural(request.plan?.length ?? 0, 'call')}`
            ) : (
              <ToolCode tool={request.tool} />
            )}
          </h2>
          <p class="inspector-meta">
            <strong>{request.agentId}</strong>
            <span class="sep">·</span>
            <span title={fullTime(request.createdAt)}>
              Requested {relativeTime(request.createdAt, now)}
            </span>
            {countdown && (
              <>
                <span class="sep">·</span>
                <span class={cx(countdown.urgent && 'c-ask')}>
                  {countdown.expired ? 'Expired' : `Expires in ${countdown.label}`}
                </span>
              </>
            )}
            {request.mode && (
              <>
                <span class="sep">·</span>
                <span>{request.mode === 'sync' ? 'Call is held open' : 'Agent will retry'}</span>
              </>
            )}
            {request.tier && !plan && !question && request.tier !== 'destructive' && (
              <>
                <span class="sep">·</span>
                <span>{request.tier === 'read' ? 'Read-only' : 'Writes'}</span>
              </>
            )}
            {request.tier === 'destructive' && !plan && !question && (
              <>
                <span class="sep">·</span>
                <span class="risk">Destructive</span>
              </>
            )}
            <span class="sep">·</span>
            <code title="Approval code">{request.code}</code>
          </p>
        </header>

        <div class="inspector-body">
          {request.escalated && (
            <Notice tone="error">
              Flagged by a detector or command policy. Scoped and permanent grants are off for this
              call; check the exact arguments before approving once.
            </Notice>
          )}

          {request.reason && (
            <section>
              <h3 class="block-title">Reason</h3>
              <p class="reason">{request.reason}</p>
            </section>
          )}

          {question && typeof request.args.context === 'string' && request.args.context.trim() && (
            <section>
              <h3 class="block-title">Context</h3>
              <p class="reason">{request.args.context}</p>
            </section>
          )}

          {request.note && (
            <section>
              <h3 class="block-title">Note</h3>
              <p class="reason">{request.note}</p>
            </section>
          )}

          {preview?.status === 'ready' && (
            <section>
              <h3 class="block-title">
                Live preview
                <span class="ink-3">
                  via <code>{String(preview.tool)}</code>
                  {preview.truncated ? ', truncated' : ''}
                </span>
              </h3>
              {fields.length ? (
                <dl class="kv">
                  {fields.map((f) => (
                    <div key={f.label}>
                      <dt>{f.label}</dt>
                      <dd class="is-text">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <pre class="code-block">{String(preview.text ?? '')}</pre>
              )}
            </section>
          )}
          {preview && preview.status !== 'ready' && preview.status !== 'unavailable' && (
            <Notice tone="warn">{String(preview.message ?? 'Preview unavailable.')}</Notice>
          )}
          {previewError && <Notice tone="warn">{previewError}</Notice>}

          {plan && request.plan?.length ? (
            <PlanSteps request={request} />
          ) : !question ? (
            <ArgsTable value={request.args} />
          ) : null}
        </div>
      </div>

      <footer class="decision-bar">
        {canDecide ? (
          <>
            <Button busy={busy} onClick={() => onDecide(request, 'deny')}>
              {denyLabel(request)}
              <Kbd>D</Kbd>
            </Button>
            <span class="spacer" />
            {plan && <span class="ink-3 hint-keys">Each call gets a single-use grant</span>}
            <div class="btn-group">
              <Button variant="primary" busy={busy} onClick={() => onDecide(request, 'approve')}>
                {approveLabel(request)}
                <Kbd>A</Kbd>
              </Button>
              {menuItems.length > 0 && (
                <Menu
                  label="Approve and allow"
                  heading="Approve and allow"
                  placement="up-right"
                  items={menuItems}
                  trigger={(props) => (
                    <Button
                      {...props}
                      variant="primary"
                      icon
                      busy={busy}
                      aria-label="Approve with a scoped grant"
                    >
                      <ChevronDown size={14} aria-hidden="true" />
                    </Button>
                  )}
                />
              )}
            </div>
          </>
        ) : (
          <span class="ink-3">
            Read-only here. Decide from the gateway dashboard or the companion app.
          </span>
        )}
      </footer>
    </>
  );
}

function PlanSteps({ request }: { request: PendingApproval }) {
  const steps = request.plan ?? [];
  const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });
  const [raw, setRaw] = useState(false);
  const allOpen = steps.every((_, i) => open[i]);
  return (
    <section>
      <h3 class="block-title">
        Steps
        <span class="ink-3">{steps.length}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '14px' }}>
          {!raw && (
            <button
              type="button"
              class="text-btn"
              onClick={() =>
                setOpen(allOpen ? {} : Object.fromEntries(steps.map((_, i) => [i, true])))
              }
            >
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          <button type="button" class="text-btn" onClick={() => setRaw(!raw)}>
            {raw ? 'Steps' : 'JSON'}
          </button>
        </span>
      </h3>
      {raw ? (
        <pre class="code-block">{JSON.stringify(request.args, null, 2)}</pre>
      ) : (
        <ol class="steps">
          {steps.map((step, i) => {
            const isOpen = Boolean(open[i]);
            const summary = Object.entries(step.args)
              .slice(0, 3)
              .map(([k, v]) => `${k}=${formatArgScalar(v, 40)}`)
              .join('  ');
            return (
              <li class={cx('step', isOpen && 'is-open')} key={i}>
                <button
                  type="button"
                  class="step-head"
                  aria-expanded={isOpen}
                  onClick={() => setOpen({ ...open, [i]: !isOpen })}
                >
                  <span class="step-num">{i + 1}</span>
                  <span class="step-main">
                    <ToolCode tool={step.tool} />
                    {!isOpen && summary && <span class="step-summary">{summary}</span>}
                  </span>
                  <ChevronRight size={14} class="step-chevron" aria-hidden="true" />
                </button>
                {isOpen && (
                  <div class="step-body">
                    <ArgsTable value={step.args} bare />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
