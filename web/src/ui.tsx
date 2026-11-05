import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { diffLines } from 'diff';
import type { Decision, EntityChange, Resolved } from './types';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'quiet' | 'danger' | 'default';
  size?: 'sm' | 'md';
  busy?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
};

export function Button({
  variant = 'default',
  size = 'md',
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
        `btn-${variant}`,
        size === 'sm' && 'btn-sm',
        busy && 'is-busy',
        className as string
      )}
      disabled={rest.disabled || busy}
    >
      {children}
    </button>
  );
}

const DECISION_LABEL: Record<Decision, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };

// Three-way allow/ask/deny control. `own` is the agent or profile's exact choice; `inherited` is what
// applies when it has none (from profiles or a wildcard), shown as a dashed outline.
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
            type="button"
            role="radio"
            aria-checked={active}
            class={cx('decision-opt', `is-${decision}`, active && 'is-active', ghost && 'is-ghost')}
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

export function DecisionMark({ decision }: { decision: Resolved }) {
  const text = decision === 'none' ? 'No access' : DECISION_LABEL[decision];
  return <span class={cx('mark', `mark-${decision}`)}>{text}</span>;
}

export function TallyBar({ counts, total }: { counts: Record<Resolved, number>; total: number }) {
  if (!total) return <div class="tally tally-empty" />;
  return (
    <div
      class="tally"
      role="img"
      aria-label={`${counts.allow} allowed, ${counts.ask} ask, ${counts.deny + counts.none} blocked`}
    >
      {(['allow', 'ask', 'deny', 'none'] as const).map((key) =>
        counts[key] ? <span class={`tally-${key}`} style={{ flexGrow: counts[key] }} /> : null
      )}
    </div>
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
    <button
      type="button"
      class={cx('chip', selected && 'is-selected')}
      aria-pressed={selected}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

// Free-form list of patterns or values, entered one at a time.
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
    <div class={cx('list-input', tone && `tone-${tone}`)}>
      <span class="list-input-label">{label}</span>
      <div class="list-input-box">
        {values.map((value) => (
          <span class="token" key={value}>
            <code>{value}</code>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((v) => v !== value))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          placeholder={values.length ? '' : placeholder}
          aria-label={label}
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

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ComponentChildren;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const field = ref.current?.querySelector<HTMLElement>(
      '.sheet-body input:not([disabled]), .sheet-body textarea'
    );
    (field ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        class={cx('sheet', wide && 'sheet-wide')}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={ref}
      >
        <header class="sheet-head">
          <h2>{title}</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div class="sheet-body">{children}</div>
        {footer && <footer class="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <p class="empty-title">{title}</p>
      {children}
    </div>
  );
}

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
}: {
  value: string;
  label?: string;
  onCopied?: () => void;
  variant?: ButtonProps['variant'];
}) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant={variant}
      size="sm"
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
      {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy blocked, select it' : label}
    </Button>
  );
}

export function relativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
