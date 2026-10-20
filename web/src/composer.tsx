import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, api } from './api';
import { createAgentSpec, draftFromAgent, draftFromProfile, profileSpec } from './drafts';
import { ID_PATTERN, resolve, tally } from './policy';
import { PolicyEditor, emptyDraft, useEffective, type Draft } from './policy-editor';
import { PreviewNotes } from './review';
import { goAfterSave, useStore, useUnsavedGuard } from './store';
import type { ChangeOp, ChangePreview, Kind, Tool } from './types';
import { Button, Chip, TallyBar, YamlDiff, cx } from './ui';

export function Composer({ kind, baseId }: { kind: Kind; baseId?: string }) {
  const { state, tools, setState, reveal, toast } = useStore();
  const section = kind === 'agent' ? state?.agents : state?.profiles;
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

  useEffect(() => nameRef.current?.focus(), []);

  const trimmed = id.trim();
  const idProblem = !trimmed
    ? null
    : !ID_PATTERN.test(trimmed)
      ? 'Use letters, numbers, dots, dashes or underscores.'
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
      else toast(`Created ${kind} ${trimmed}.`);
      goAfterSave(kind === 'agent' ? 'agents' : 'profiles', trimmed);
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
    <div class="composer">
      <div class="composer-main">
        <a class="back" href={kind === 'agent' ? '#/agents' : '#/profiles'}>
          {kind === 'agent' ? 'Agents' : 'Profiles'}
        </a>
        <h1 class="page-title">New {noun}</h1>
        <p class="lede">
          {kind === 'agent'
            ? 'An agent is one client, like Claude Code on your laptop or Codex on a server. It gets its own key and its own rules.'
            : 'A profile is a reusable set of rules. Agents and other profiles build on it.'}
        </p>

        <section class="name-block">
          <label for="entity-name" class="field-label">
            Name
          </label>
          <input
            id="entity-name"
            ref={nameRef}
            class={cx('name-input', idProblem && 'has-error')}
            value={id}
            placeholder={kind === 'agent' ? 'codex-ci' : 'github-read'}
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
                  Connects at <code>/agents/{trimmed || 'name'}/mcp</code>
                </>
              ) : (
                'Agents refer to it by this name.'
              ))}
          </p>
          {others.length > 0 && (
            <div class="copy-from">
              <span class="field-label">Copy rules from</span>
              <div class="chips">
                <Chip
                  selected={!base}
                  onClick={() => {
                    setBase(undefined);
                    setDraft(emptyDraft());
                  }}
                >
                  Start empty
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
            </div>
          )}
        </section>

        <PolicyEditor kind={kind} draft={draft} onChange={setDraft} />
      </div>

      <aside class="composer-side">
        <Outcome kind={kind} name={trimmed} draft={draft} tools={tools} preview={preview} />
        {error && <p class="notice notice-error">{error}</p>}
        <Button variant="primary" class="create-btn" busy={busy} onClick={create}>
          Create {noun}
        </Button>
        <p class="kbd-hint">
          <kbd>⌘</kbd>
          <kbd>Enter</kbd> creates from anywhere on this page
        </p>
      </aside>
    </div>
  );
}

// The live answer to "what will this be able to do?", plus the exact YAML that will be written.
function Outcome({
  kind,
  name,
  draft,
  tools,
  preview,
}: {
  kind: Kind;
  name: string;
  draft: Draft;
  tools: Tool[];
  preview: ChangePreview | null;
}) {
  const { effective } = useEffective(kind, draft);
  const counts = tally(effective, tools);
  const askTools = tools.filter((t) => resolve(effective, t.name).decision === 'ask');
  const allowTools = tools.filter((t) => resolve(effective, t.name).decision === 'allow');
  const change = preview?.changes[0];
  const blocked = counts.deny + counts.none;

  return (
    <div class="outcome">
      <h2 class="outcome-title">
        {name || (kind === 'agent' ? 'Your new agent' : 'Your new profile')}
      </h2>
      {tools.length > 0 ? (
        <>
          <TallyBar counts={counts} total={tools.length} />
          <dl class="outcome-stats">
            <div class="stat-allow">
              <dt>Runs right away</dt>
              <dd>{counts.allow}</dd>
            </div>
            <div class="stat-ask">
              <dt>Asks you first</dt>
              <dd>{counts.ask}</dd>
            </div>
            <div class="stat-none">
              <dt>Blocked</dt>
              <dd>{blocked}</dd>
            </div>
          </dl>
          {counts.allow + counts.ask === 0 ? (
            <p class="hint">Nothing is reachable yet. Pick a profile or allow some tools.</p>
          ) : (
            <>
              <ToolPeek title="Asks you first" tools={askTools} />
              <ToolPeek title="Runs right away" tools={allowTools} />
            </>
          )}
        </>
      ) : (
        <p class="hint">Tool counts appear once providers report their tools.</p>
      )}
      {change && (
        <details class="yaml-peek">
          <summary>YAML that will be written</summary>
          <YamlDiff change={change} />
        </details>
      )}
      {preview && <PreviewNotes preview={preview} />}
    </div>
  );
}

function ToolPeek({ title, tools }: { title: string; tools: Tool[] }) {
  if (!tools.length) return null;
  const shown = tools.slice(0, 6);
  return (
    <div class="peek">
      <h3>{title}</h3>
      <ul>
        {shown.map((t) => (
          <li key={t.name}>
            <code>{t.name}</code>
          </li>
        ))}
      </ul>
      {tools.length > shown.length && <p class="hint">and {tools.length - shown.length} more</p>}
    </div>
  );
}
