import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { diffLines } from 'diff';
import { Check, CircleAlert, Plus, Search as SearchIcon, TriangleAlert, X } from 'lucide-preact';
import type { Decision, EntityChange, GrantScope, Resolved } from './types';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---------- Buttons ----------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: boolean;
  busy?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
};

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  busy,
  class: className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      class={cx(
        'btn',
        variant !== 'default' && `btn-${variant}`,
        size !== 'md' && `btn-${size}`,
        icon && 'btn-icon',
        busy && 'is-busy',
        className as string
      )}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd>{children}</kbd>;
}

export function SearchInput({
  value,
  onInput,
  placeholder,
  label,
  pageSearch = true,
  class: className,
}: {
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
  label: string;
  pageSearch?: boolean;
  class?: string;
}) {
  return (
    <label class={cx('search', className)}>
      <SearchIcon size={14} aria-hidden="true" />
      <input
        type="search"
        class="input"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autocomplete="off"
        spellcheck={false}
        data-page-search={pageSearch ? 'true' : undefined}
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (value) onInput('');
            else e.currentTarget.blur();
          }
        }}
      />
      {pageSearch && <kbd aria-hidden="true">/</kbd>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  class: className,
}: {
  value: T;
  options: { value: T; label: ComponentChildren; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  class?: string;
}) {
  return (
    <div class={cx('segmented', className)} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          aria-label={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Allow / Ask / Deny ----------

const DECISION_LABEL: Record<Decision, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };

// `own` is this entity's exact choice; `inherited` is what applies without one (profiles or a
// wildcard), drawn as a dashed ring so it never reads as the entity's own rule.
export function DecisionSwitch({
  own,
  inherited,
  inheritedFrom,
  onChange,
  label,
}: {
  own: Decision | null;
  inherited: Resolved;
  inheritedFrom?: string;
  onChange: (decision: Decision | null) => void;
  label: string;
}) {
  return (
    <div class="decision" role="radiogroup" aria-label={label}>
      {(['allow', 'ask', 'deny'] as const).map((decision) => {
        const active = own === decision;
        const ghost = !own && inherited === decision;
        return (
          <button
            key={decision}
            type="button"
            role="radio"
            aria-checked={active}
            class={cx(`is-${decision}`, ghost && 'is-ghost')}
            title={
              ghost && inheritedFrom
                ? `${DECISION_LABEL[decision]} via ${inheritedFrom}. Click to set it here.`
                : active
                  ? 'Click again to clear'
                  : DECISION_LABEL[decision]
            }
            onClick={() => onChange(active ? null : decision)}
          >
            {DECISION_LABEL[decision]}
          </button>
        );
      })}
    </div>
  );
}

export function AccessBar({ counts, total }: { counts: Record<Resolved, number>; total: number }) {
  return (
    <div
      class="access-bar"
      role="img"
      aria-label={`${counts.allow} allowed, ${counts.ask} ask, ${counts.deny + counts.none} blocked`}
    >
      {total > 0 &&
        (['allow', 'ask', 'deny', 'none'] as const).map((key) =>
          counts[key] ? (
            <span key={key} class={`is-${key}`} style={{ flexGrow: counts[key] }} />
          ) : null
        )}
    </div>
  );
}

export function AccessCounts({ counts }: { counts: Record<Resolved, number> }) {
  return (
    <span class="access-counts">
      <span>
        <span class="dot is-allow" aria-hidden="true" />
        <strong>{counts.allow}</strong> allow
      </span>
      <span>
        <span class="dot is-ask" aria-hidden="true" />
        <strong>{counts.ask}</strong> ask
      </span>
      <span>
        <span class="dot" aria-hidden="true" />
        <strong>{counts.deny + counts.none}</strong> blocked
      </span>
    </span>
  );
}

export function Chip({
  selected,
  onClick,
  children,
  title,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ComponentChildren;
  title?: string;
}) {
  return (
    <button type="button" class="chip" aria-pressed={selected} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

// ---------- Inputs ----------

export function ListInput({
  values,
  onChange,
  placeholder,
  label,
  tone,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  label: string;
  tone?: Decision;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const value = draft.trim();
    if (value && !values.includes(value)) onChange([...values, value]);
    setDraft('');
  };
  return (
    <div class="list-input">
      <span class="list-input-label">
        {tone && <span class={cx('dot', `is-${tone}`)} aria-hidden="true" />}
        {label}
      </span>
      <div class="list-input-box">
        {values.map((value) => (
          <span class="token" key={value}>
            <code>{value}</code>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((v) => v !== value))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          placeholder={values.length ? '' : placeholder}
          aria-label={label}
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
        />
      </div>
    </div>
  );
}

export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  label,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  label: string;
}) {
  const update = (index: number, field: 'key' | 'value', next: string) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, [field]: next } : r)));
  return (
    <div class="kv-editor">
      {rows.map((row, i) => (
        <div class="kv-editor-row" key={i}>
          <input
            class="input"
            value={row.key}
            placeholder={keyPlaceholder}
            spellcheck={false}
            autocomplete="off"
            aria-label={`${label} ${i + 1} name`}
            onInput={(e) => update(i, 'key', e.currentTarget.value)}
          />
          <input
            class="input"
            value={row.value}
            placeholder={valuePlaceholder}
            spellcheck={false}
            autocomplete="off"
            aria-label={`${label} ${i + 1} value`}
            onInput={(e) => update(i, 'value', e.currentTarget.value)}
          />
          <Button
            variant="ghost"
            icon
            aria-label={`Remove ${row.key || `${label} ${i + 1}`}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        <Plus size={14} aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}

// ---------- Diff ----------

export function YamlDiff({ change }: { change: EntityChange }) {
  const asBlock = (text: string | null) => (text ? `${text}\n` : '');
  const parts = diffLines(asBlock(change.before), asBlock(change.after));
  return (
    <pre class="diff">
      {parts.flatMap((part, i) =>
        part.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line, j) => (
            <span
              key={`${i}-${j}`}
              class={cx('diff-line', part.added && 'is-added', part.removed && 'is-removed')}
            >
              <span class="diff-sign" aria-hidden="true">
                {part.added ? '+' : part.removed ? '−' : ' '}
              </span>
              {line || ' '}
            </span>
          ))
      )}
    </pre>
  );
}

// ---------- Overlays ----------

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide,
  dialog,
  class: className,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
  dialog?: boolean;
  class?: string;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`sheet-${Math.random().toString(36).slice(2, 8)}`).current;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const field = ref.current?.querySelector<HTMLElement>(
      '.sheet-body input:not([disabled]):not([readonly]), .sheet-body textarea'
    );
    (field ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      class={cx('scrim', dialog && 'is-dialog')}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        class={cx('sheet', wide && 'is-wide', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        tabIndex={-1}
        ref={ref}
      >
        <header class="sheet-head">
          <div class="sheet-head-text">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div class="sheet-sub">{subtitle}</div>}
          </div>
          <Button variant="ghost" icon size="sm" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </Button>
        </header>
        <div class="sheet-body">{children}</div>
        {footer && <footer class="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export interface MenuItem {
  id: string;
  label: ComponentChildren;
  sub?: ComponentChildren;
  hint?: ComponentChildren;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

// A small menu anchored to its trigger. Arrow keys move, Enter picks, Escape closes.
export function Menu({
  trigger,
  items,
  label,
  placement = 'down-right',
  heading,
}: {
  trigger: (props: {
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    onClick: () => void;
  }) => ComponentChildren;
  items: MenuItem[];
  label: string;
  placement?: 'down-right' | 'down-left' | 'up-right' | 'up-left';
  heading?: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [vertical, horizontal] = placement.split('-');

  useEffect(() => {
    if (!open) return;
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        ref.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = Array.from(
          ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
        );
        const index = list.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? index + 1 : index - 1;
        list[(next + list.length) % list.length]?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div class="menu-anchor" ref={ref}>
      {trigger({ 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(!open) })}
      {open && (
        <div
          class={cx('menu', `is-${vertical}`, `is-${horizontal}`)}
          role="menu"
          aria-label={label}
        >
          {heading && <div class="menu-label">{heading}</div>}
          {items.map((item) => (
            <>
              {item.separatorBefore && <div class="menu-sep" role="separator" />}
              <button
                key={item.id}
                type="button"
                role="menuitem"
                class={cx('menu-item', item.danger && 'is-danger')}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span>{item.label}</span>
                {item.hint && <span class="menu-hint">{item.hint}</span>}
                {item.sub && <small>{item.sub}</small>}
              </button>
            </>
          ))}
        </div>
      )}
    </div>
  );
}

export function Empty({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <div class="empty">
      {icon}
      <p class="empty-title">{title}</p>
      {children}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error';
  children: ComponentChildren;
}) {
  return (
    <div
      class={cx('notice', tone !== 'info' && `is-${tone}`)}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {tone === 'error' ? (
        <CircleAlert size={15} aria-hidden="true" />
      ) : tone === 'warn' ? (
        <TriangleAlert size={15} aria-hidden="true" />
      ) : null}
      <div>{children}</div>
    </div>
  );
}

// ---------- Clipboard ----------

export async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Clipboard API is missing or blocked (http origins, embedded browsers); fall back below.
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copy failed. Select the text and copy it by hand.');
}

export function CopyButton({
  value,
  label = 'Copy',
  onCopied,
  variant = 'default',
  size = 'sm',
}: {
  value: string;
  label?: string;
  onCopied?: () => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant={variant}
      size={size}
      onClick={async () => {
        try {
          await copyText(value);
          setCopied('yes');
          onCopied?.();
        } catch {
          setCopied('failed');
        }
      }}
    >
      {copied === 'yes' && <Check size={14} aria-hidden="true" />}
      {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Select and copy' : label}
    </Button>
  );
}

// ---------- Time ----------

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function relativeTime(value: string, now = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

export function clockTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : CLOCK.format(date);
}

export function fullTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : FULL.format(date);
}

/** Human duration: 850ms, 1.2s, 5m, 1h 30m. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60)
    return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, '') : Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatCountdown(
  expiresAt: string | undefined,
  now: number
): { label: string; urgent: boolean; expired: boolean } | null {
  if (!expiresAt) return null;
  const target = Date.parse(expiresAt);
  if (Number.isNaN(target)) return null;
  const remainingSec = Math.ceil((target - now) / 1000);
  if (remainingSec <= 0) return { label: 'Expired', urgent: true, expired: true };
  if (remainingSec < 60) return { label: `${remainingSec}s`, urgent: true, expired: false };
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  if (mins < 60) {
    return {
      label: mins < 10 && secs > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${mins}m`,
      urgent: mins < 2,
      expired: false,
    };
  }
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return { label: remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`, urgent: false, expired: false };
}

/** Fraction of a window still left, 0..1. */
export function remainingFraction(
  createdAt: string,
  expiresAt: string | undefined,
  now: number
): number | null {
  if (!expiresAt) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(expiresAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.min(1, Math.max(0, (end - now) / (end - start)));
}

// ---------- Tools and arguments ----------

export function formatToolName(tool: string): { provider: string | null; name: string } {
  const slash = tool.indexOf('/');
  if (slash <= 0) return { provider: null, name: tool };
  return { provider: tool.slice(0, slash), name: tool.slice(slash + 1) };
}

export function ToolCode({ tool, class: className }: { tool: string; class?: string }) {
  const { provider, name } = formatToolName(tool);
  return (
    <code class={cx('tool', className)}>
      {provider && <span class="tool-prov">{provider}/</span>}
      {name}
    </code>
  );
}

export function formatGrantScope(scope: GrantScope): { kindLabel: string; target: string } {
  switch (scope.kind) {
    case 'call':
      return { kindLabel: 'Exact call', target: scope.tool };
    case 'tool':
      return { kindLabel: 'Tool', target: scope.tool };
    case 'tier':
      return {
        kindLabel: scope.tier === 'read' ? 'Read-only tools' : 'Non-destructive tools',
        target: scope.provider ? `${scope.provider}/*` : 'all providers',
      };
    case 'provider':
      return { kindLabel: 'Provider', target: `${scope.provider}/*` };
    case 'profile':
      return { kindLabel: 'Profile', target: scope.profile };
  }
}

export function formatArgScalar(value: unknown, maxLen = 72): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const encoded = JSON.stringify(value);
  return encoded.length > maxLen ? `${encoded.slice(0, maxLen - 1)}…` : encoded;
}

export function summarizeArgs(args: Record<string, unknown>, maxPairs = 3): string {
  return Object.entries(args)
    .filter(([k]) => k !== '_airlock')
    .slice(0, maxPairs)
    .map(([key, value]) => `${key}=${formatArgScalar(value, 48)}`)
    .join('  ');
}

export function prettyJson(value: unknown): string {
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(String(value)), null, 2);
  } catch {
    return String(value ?? '');
  }
}

export function parseObjectArgs(value: unknown): Record<string, unknown> | null {
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
      return null;
    }
  }
  return null;
}

function ArgValue({ value }: { value: unknown }) {
  if (
    Array.isArray(value) &&
    value.length <= 12 &&
    value.every((v) => v === null || typeof v !== 'object')
  ) {
    return (
      <span class="arr">
        {value.map((item, i) => (
          <span key={i}>{String(item)}</span>
        ))}
      </span>
    );
  }
  if (value !== null && typeof value === 'object') {
    return <pre>{JSON.stringify(value, null, 2)}</pre>;
  }
  return <>{value === undefined ? '—' : String(value)}</>;
}

/** Arguments as a hairline key/value table, with a raw JSON escape hatch. */
export function ArgsTable({
  value,
  title = 'Arguments',
  bare,
}: {
  value: unknown;
  title?: string;
  bare?: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const obj = parseObjectArgs(value);
  const entries = obj ? Object.entries(obj).filter(([k]) => k !== '_airlock') : null;

  const body =
    !entries || raw ? (
      <pre class="code-block">{prettyJson(obj ?? value)}</pre>
    ) : entries.length === 0 ? (
      <p class="ink-3">No arguments</p>
    ) : (
      <dl class="kv">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              <ArgValue value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );

  if (bare) return body;
  return (
    <section>
      <h3 class="block-title">
        {title}
        {entries && entries.length > 0 && <span class="ink-3">{entries.length}</span>}
        {entries && entries.length > 0 && (
          <button type="button" class="text-btn" onClick={() => setRaw(!raw)}>
            {raw ? 'Table' : 'JSON'}
          </button>
        )}
      </h3>
      {body}
    </section>
  );
}
