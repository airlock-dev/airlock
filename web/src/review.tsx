import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from './api';
import { useStore } from './store';
import type { ApplyResult, ChangeOp, ChangePreview, EntityChange } from './types';
import { Button, Notice, Sheet, YamlDiff, cx } from './ui';

const ACTION_LABEL: Record<EntityChange['action'], string> = {
  create: 'New',
  update: 'Changed',
  delete: 'Removed',
  rotate: 'New key for',
};

export function ChangeList({ preview }: { preview: ChangePreview }) {
  return (
    <div class="change-list">
      {preview.changes.map((change) => (
        <section class="change" key={`${change.kind}:${change.id}`}>
          <header class="change-head">
            <span class={cx('action', `is-${change.action}`)}>{ACTION_LABEL[change.action]}</span>
            <span class="ink-3">{change.kind}</span>
            <code>{change.id}</code>
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
        <Notice tone="error">
          <ul>
            {errors.map((d, i) => (
              <li key={i}>
                {d.agent ? <strong>{d.agent}: </strong> : null}
                {d.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {preview.warnings.length > 0 && (
        <Notice tone="warn">
          <ul>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
    </>
  );
}

// Preview a change set as a YAML diff, then apply it after an explicit click.
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
        setError(`${e.message} The diff below is fresh; check it and apply again.`);
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
      subtitle="Changes to airlock.yaml. The gateway picks them up on its own."
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {note && <Notice tone="warn">{note}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {preview ? (
          <ChangeList preview={preview} />
        ) : (
          !error && <p class="ink-3">Preparing the diff…</p>
        )}
      </div>
    </Sheet>
  );
}
