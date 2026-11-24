import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ChevronRight } from 'lucide-preact';
import { ApiError, api } from './api';
import { createAgentSpec, draftFromAgent, draftFromProfile, profileSpec } from './drafts';
import { ID_PATTERN, resolve } from './policy';
import { PolicyEditor, emptyDraft, useEffective, type Draft } from './policy-editor';
import { PreviewNotes } from './review';
import { goAfterSave, useStore, useUnsavedGuard } from './store';
import type { ChangeOp, ChangePreview, Kind, Tool } from './types';
import { Button, Chip, Kbd, Notice, YamlDiff, cx } from './ui';

export function Composer({ kind, baseId }: { kind: Kind; baseId?: string }) {
  const { state, tools, setState, reveal, toast } = useStore();
  const section = kind === 'agent' ? state?.agents : state?.profiles;
  const sectionPath = kind === 'agent' ? 'agents' : 'profiles';
  const [id, setId] = useState(() => (baseId ? copyName(baseId) : ''));
  const [base, setBase] = useState<string | undefined>(baseId);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(kind, baseId));
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  function copyName(from: string): string {
    const taken = section ?? {};
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? `${from}-copy` : `${from}-copy-${n}`;
      if (!taken[candidate]) return candidate;
    }
  }

  function initialDraft(k: Kind, from?: string): Draft {
    if (from && k === 'agent' && state?.agents[from]) return draftFromAgent(state.agents[from]);
    if (from && k === 'profile' && state?.profiles[from])
      return draftFromProfile(state.profiles[from]);
    return emptyDraft();
  }

  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) nameRef.current?.focus();
  }, []);

  const trimmed = id.trim();
  const idProblem = !trimmed
    ? null
    : !ID_PATTERN.test(trimmed)
      ? 'Use letters, numbers, dots, dashes, or underscores.'
      : section?.[trimmed]
        ? `There is already ${kind === 'agent' ? 'an agent' : 'a profile'} called ${trimmed}.`
        : null;
  const ready = Boolean(trimmed) && !idProblem;
  const pristine = useMemo(() => JSON.stringify(initialDraft(kind, baseId)), []);
  useUnsavedGuard(!busy && (JSON.stringify(draft) !== pristine || (!baseId && Boolean(trimmed))));

  const ops = useMemo<ChangeOp[]>(
    () =>
      kind === 'agent'
        ? [{ op: 'create_agent', id: trimmed || 'new-agent', agent: createAgentSpec(draft) }]
        : [{ op: 'create_profile', id: trimmed || 'new-profile', profile: profileSpec(draft) }],
    [kind, trimmed, draft]
  );

  useEffect(() => {
    if (idProblem) return;
    const timer = setTimeout(() => {
      api.preview(ops).then(setPreview, () => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [JSON.stringify(ops), idProblem]);

  const create = async () => {
    if (!ready) {
      nameRef.current?.focus();
      setError(trimmed ? idProblem : `Give the ${kind} a name first.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.apply(ops, preview?.version);
      setState(result.state);
      if (result.createdKeys.length) reveal(result.createdKeys);
      else toast(`Created ${kind} ${trimmed}`);
      goAfterSave(sectionPath, trimmed);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'The config changed on disk. Check the preview and try again.'
          : (e as Error).message
      );
      api.preview(ops).then(setPreview, () => {});
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        create();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const others = Object.keys(section ?? {});
  const noun = kind === 'agent' ? 'agent' : 'profile';

  return (
    <>
      <header class="topbar">
        <nav class="crumb" aria-label="Breadcrumb">
          <a href={`#/${sectionPath}`}>{kind === 'agent' ? 'Agents' : 'Profiles'}</a>
          <ChevronRight size={13} aria-hidden="true" />
          <span class="current" aria-current="page">
            New {noun}
          </span>
        </nav>
        <div class="topbar-actions">
          <Button variant="primary" busy={busy} onClick={create}>
            Create {noun}
            <Kbd>⌘&nbsp;↵</Kbd>
          </Button>
        </div>
      </header>

      <div class="page">
        <section class="composer-name">
          <label for="entity-name" class="field-label">
            Name
          </label>
          <input
            id="entity-name"
            ref={nameRef}
            class="input name-input"
            name={`${noun}-name`}
            value={id}
            placeholder={kind === 'agent' ? 'codex-ci…' : 'github-read…'}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => {
              setId(e.currentTarget.value.replace(/\s+/g, '-'));
              setError(null);
            }}
            aria-invalid={Boolean(idProblem)}
            aria-describedby="entity-name-help"
          />
          <p id="entity-name-help" class={cx('field-help', idProblem && 'is-error')}>
            {idProblem ??
              (kind === 'agent' ? (
                <>
                  One client, like Claude Code on your laptop. It connects at{' '}
                  <code>/agents/{trimmed || 'name'}/mcp</code>
                </>
              ) : (
                'A reusable rule set. Agents refer to it by this name.'
              ))}
          </p>
          {others.length > 0 && (
            <div class="copy-from" role="group" aria-label="Copy rules from">
              <span class="label">Start from</span>
              <Chip
                selected={!base}
                onClick={() => {
                  setBase(undefined);
                  setDraft(emptyDraft());
                }}
              >
                Empty
              </Chip>
              {others.map((other) => (
                <Chip
                  key={other}
                  selected={base === other}
                  onClick={() => {
                    setBase(other);
                    setDraft(initialDraft(kind, other));
                  }}
                >
                  {other}
                </Chip>
              ))}
            </div>
          )}
          {error && (
            <div style={{ marginTop: '8px' }}>
              <Notice tone="error">{error}</Notice>
            </div>
          )}
        </section>

        <PolicyEditor
          kind={kind}
          draft={draft}
          onChange={setDraft}
          aside={<Outcome kind={kind} draft={draft} tools={tools} preview={preview} />}
        />
      </div>
    </>
  );
}

// What the new entity will reach, plus the exact YAML that will be written.
function Outcome({
  kind,
  draft,
  tools,
  preview,
}: {
  kind: Kind;
  draft: Draft;
  tools: Tool[];
  preview: ChangePreview | null;
}) {
  const { effective } = useEffective(kind, draft);
  const askTools = tools.filter((t) => resolve(effective, t.name).decision === 'ask');
  const allowTools = tools.filter((t) => resolve(effective, t.name).decision === 'allow');
  const change = preview?.changes[0];

  return (
    <div class="aside-block peek">
      {tools.length > 0 && allowTools.length + askTools.length === 0 ? (
        <p class="field-help">Nothing is reachable yet. Inherit a profile or allow some tools.</p>
      ) : (
        <>
          <ToolPeek title="Asks you first" tools={askTools} />
          <ToolPeek title="Runs right away" tools={allowTools} />
        </>
      )}
      {change && (
        <details class="disclosure">
          <summary>
            <ChevronRight size={13} aria-hidden="true" />
            YAML to be written
          </summary>
          <div class="disclosure-body">
            <YamlDiff change={change} />
          </div>
        </details>
      )}
      {preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
          <PreviewNotes preview={preview} />
        </div>
      )}
    </div>
  );
}

function ToolPeek({ title, tools }: { title: string; tools: Tool[] }) {
  if (!tools.length) return null;
  const shown = tools.slice(0, 6);
  return (
    <div>
      <h4>{title}</h4>
      <ul>
        {shown.map((t) => (
          <li key={t.name}>
            <code>{t.name}</code>
          </li>
        ))}
      </ul>
      {tools.length > shown.length && (
        <p class="field-help">and {tools.length - shown.length} more</p>
      )}
    </div>
  );
}
