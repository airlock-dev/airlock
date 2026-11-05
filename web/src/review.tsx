import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from './api';
import { useStore } from './store';
import type { ApplyResult, ChangeOp, ChangePreview, EntityChange } from './types';
import { Button, Sheet, YamlDiff, cx } from './ui';

const ACTION_LABEL: Record<EntityChange['action'], string> = {
  create: 'New',
  update: 'Changed',
  delete: 'Removed',
  rotate: 'New key',
};

export function ChangeList({ preview }: { preview: ChangePreview }) {
  return (
    <div class="change-list">
      {preview.changes.map((change) => (
        <section class="change" key={`${change.kind}:${change.id}`}>
          <header class="change-head">
            <span class={cx('change-action', `is-${change.action}`)}>
              {ACTION_LABEL[change.action]}
            </span>
            <span class="change-kind">{change.kind}</span>
            <code class="change-id">{change.id}</code>
          </header>
          <YamlDiff change={change} />
        </section>
      ))}
      <PreviewNotes preview={preview} />
    </div>
  );
}

export function PreviewNotes({ preview }: { preview: ChangePreview }) {
  const errors = preview.diagnostics.filter((d) => d.level === 'error');
  return (
    <>
      {errors.length > 0 && (
        <ul class="notice notice-error">
          {errors.map((d, i) => (
            <li key={i}>
              {d.agent ? <strong>{d.agent}: </strong> : null}
              {d.message}
            </li>
          ))}
        </ul>
      )}
      {preview.warnings.length > 0 && (
        <ul class="notice notice-warn">
          {preview.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}

// Preview a change set, then apply it after an explicit click. Used for edits and assistant proposals.
export function ReviewSheet({
  ops,
  title,
  open,
  onClose,
  onApplied,
  applyLabel = 'Apply changes',
  danger,
  successMessage = 'Saved. The gateway reloads its config on its own.',
  note,
  initialPreview,
}: {
  ops: ChangeOp[];
  title: string;
  open: boolean;
  onClose: () => void;
  onApplied?: (result: ApplyResult) => void;
  applyLabel?: string;
  danger?: boolean;
  successMessage?: string;
  note?: ComponentChildren;
  initialPreview?: ChangePreview;
}) {
  const { setState, reveal, toast } = useStore();
  const [preview, setPreview] = useState<ChangePreview | null>(initialPreview ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    // Always re-preview so the version reflects the file as it is now.
    api.preview(ops).then(setPreview, (e: Error) => setError(e.message));
  }, [open, JSON.stringify(ops)]);

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.apply(ops, preview.version);
      setState(result.state);
      if (result.createdKeys.length) {
        const rotated = new Set(
          ops.filter((op) => op.op === 'rotate_agent_key').map((op) => op.id)
        );
        reveal(result.createdKeys.map((k) => ({ ...k, rotated: rotated.has(k.agentId) })));
      } else {
        toast(successMessage);
      }
      onApplied?.(result);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(e.message);
        api.preview(ops).then(setPreview, () => {});
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      wide
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            busy={busy}
            disabled={!preview?.ok}
            onClick={apply}
          >
            {applyLabel}
          </Button>
        </>
      }
    >
      {note && <div class="notice notice-warn">{note}</div>}
      {error && <p class="notice notice-error">{error}</p>}
      {preview ? (
        <ChangeList preview={preview} />
      ) : (
        !error && <p class="hint">Preparing the diff…</p>
      )}
    </Sheet>
  );
}
