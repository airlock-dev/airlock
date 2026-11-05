import { useMemo, useState } from 'preact/hooks';
import {
  applyRecommended,
  effectiveRules,
  groupByProvider,
  inheritedRules,
  resolve,
  setExact,
  setProviderWide,
  tally,
} from './policy';
import { useStore } from './store';
import type { Decision, Kind, Profile, Rules, Tool } from './types';
import { Button, Chip, DecisionSwitch, ListInput, TallyBar, cx } from './ui';

export interface Draft extends Rules {
  inheritDefault: boolean;
  approvalMode: 'sync' | 'async' | null;
  exec: { allow: string[]; ask: string[]; deny: string[] };
  http: { domainAllowlist: string[] };
}

export function emptyDraft(): Draft {
  return {
    extends: [],
    allow: [],
    ask: [],
    deny: [],
    inheritDefault: true,
    approvalMode: null,
    exec: { allow: [], ask: [], deny: [] },
    http: { domainAllowlist: [] },
  };
}

export function useEffective(kind: Kind, draft: Draft) {
  const { state } = useStore();
  return useMemo(() => {
    const profiles = state?.profiles ?? {};
    const defaultProfile =
      kind === 'agent' && draft.inheritDefault ? state?.defaultProfile : undefined;
    const effective = effectiveRules(draft, profiles, defaultProfile);
    // What applies to a tool when this entity has no exact rule for it: profile rules plus this
    // entity's wildcards. Exact patterns only ever match their own tool, so they can be dropped.
    const wildcard = (patterns: string[]) => patterns.filter((p) => p.endsWith('*'));
    const chain =
      defaultProfile && !draft.extends.includes(defaultProfile)
        ? [defaultProfile, ...draft.extends]
        : draft.extends;
    const inherited = inheritedRules(chain, profiles);
    const background = {
      allow: [...inherited.allow, ...wildcard(draft.allow)],
      ask: [...inherited.ask, ...wildcard(draft.ask)],
      deny: [...inherited.deny, ...wildcard(draft.deny)],
    };
    return { effective, background };
  }, [kind, draft, state]);
}

export function PolicyEditor({
  kind,
  selfId,
  draft,
  onChange,
}: {
  kind: Kind;
  selfId?: string;
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  const { state, tools, toolsLoaded, toolsLoading, toolErrors, refreshTools } = useStore();
  const profiles = state?.profiles ?? {};
  const { effective, background } = useEffective(kind, draft);
  const hasExec = tools.some((t) => t.name === 'exec/run') || Boolean(state?.providers.exec);
  const execBlocked =
    ['none', 'deny'].includes(resolve(effective, 'exec/run').decision) &&
    draft.exec.allow.length + draft.exec.ask.length + draft.exec.deny.length > 0;
  const hasHttp = tools.some((t) => t.provider === 'http') || Boolean(state?.providers.http);

  return (
    <div class="policy">
      <section class="policy-section">
        <header class="policy-head">
          <h3>Builds on</h3>
          <p>
            Profiles are shared permission sets. Pick any to start from; anything you set below
            overrides them.
          </p>
        </header>
        <ProfilePicker
          kind={kind}
          selfId={selfId}
          draft={draft}
          onChange={onChange}
          profiles={profiles}
          tools={tools}
        />
      </section>

      <section class="policy-section">
        <header class="policy-head policy-head-row">
          <div>
            <h3>Tools</h3>
            <p>
              Allow runs right away. Ask waits for you to approve. Anything without a rule is
              blocked.
            </p>
          </div>
          <div class="policy-head-actions">
            <Button size="sm" variant="quiet" busy={toolsLoading} onClick={() => refreshTools()}>
              Reload tools
            </Button>
          </div>
        </header>
        {toolErrors.length > 0 && (
          <ul class="notice notice-warn">
            {toolErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
        {!toolsLoaded ? (
          <div class="loading-rows" aria-busy="true">
            <span>Asking each provider for its tools…</span>
          </div>
        ) : (
          <ToolMatrix
            draft={draft}
            onChange={onChange}
            tools={tools}
            effective={effective}
            background={background}
            profiles={profiles}
          />
        )}
        <details class="patterns">
          <summary>Edit rules as patterns</summary>
          <p class="hint">
            <code>github/*</code> matches every GitHub tool, <code>github/list*</code> matches a
            prefix. The most specific rule wins.
          </p>
          <div class="pattern-grid">
            {(['allow', 'ask', 'deny'] as const).map((decision) => (
              <ListInput
                key={decision}
                tone={decision}
                label={decision === 'allow' ? 'Allow' : decision === 'ask' ? 'Ask' : 'Deny'}
                placeholder="provider/tool"
                values={draft[decision]}
                onChange={(values) => onChange({ ...draft, [decision]: values })}
              />
            ))}
          </div>
        </details>
      </section>

      {kind === 'agent' && hasExec && (
        <section class="policy-section">
          <header class="policy-head">
            <h3>Shell commands</h3>
            <p>
              Narrow what <code>exec/run</code> may execute by command prefix, like{' '}
              <code>git status*</code>. Leave empty to use the tool rule alone.
            </p>
          </header>
          {execBlocked && (
            <p class="notice notice-warn">
              <code>exec/run</code> is blocked for this agent, so these rules have no effect. Set it
              to Allow or Ask under Tools.
            </p>
          )}
          <div class="pattern-grid">
            {(['allow', 'ask', 'deny'] as const).map((decision) => (
              <ListInput
                key={decision}
                tone={decision}
                label={decision === 'allow' ? 'Allow' : decision === 'ask' ? 'Ask' : 'Deny'}
                placeholder={
                  decision === 'deny' ? 'rm -rf*' : decision === 'ask' ? 'git push*' : 'git status*'
                }
                values={draft.exec[decision]}
                onChange={(values) =>
                  onChange({ ...draft, exec: { ...draft.exec, [decision]: values } })
                }
              />
            ))}
          </div>
        </section>
      )}

      {kind === 'agent' && hasHttp && (
        <section class="policy-section">
          <header class="policy-head">
            <h3>Web requests</h3>
            <p>
              Domains the HTTP tool may reach. Empty means no domain restriction beyond the tool
              rule.
            </p>
          </header>
          <ListInput
            label="Domains"
            placeholder="api.github.com"
            values={draft.http.domainAllowlist}
            onChange={(values) => onChange({ ...draft, http: { domainAllowlist: values } })}
          />
        </section>
      )}

      {kind === 'agent' && (
        <section class="policy-section">
          <header class="policy-head">
            <h3>While you decide</h3>
            <p>What the agent sees when a call needs your approval.</p>
          </header>
          <div class="choice-row" role="radiogroup" aria-label="Approval mode">
            {(
              [
                [null, 'Gateway default', 'Follow approvals.mode in the config.'],
                ['sync', 'Hold the call', 'The tool call waits until you approve or deny.'],
                [
                  'async',
                  'Answer right away',
                  'The agent gets "approval pending" and retries later. For clients that time out.',
                ],
              ] as const
            ).map(([value, title, body]) => (
              <button
                type="button"
                role="radio"
                aria-checked={draft.approvalMode === value}
                class={cx('choice', draft.approvalMode === value && 'is-selected')}
                onClick={() => onChange({ ...draft, approvalMode: value })}
              >
                <strong>{title}</strong>
                <span>{body}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ProfilePicker({
  kind,
  selfId,
  draft,
  onChange,
  profiles,
  tools,
}: {
  kind: Kind;
  selfId?: string;
  draft: Draft;
  onChange: (draft: Draft) => void;
  profiles: Record<string, Profile>;
  tools: Tool[];
}) {
  const { state } = useStore();
  const ids = Object.keys(profiles).filter((id) => id !== selfId);
  const defaultProfile = kind === 'agent' ? state?.defaultProfile : undefined;
  if (ids.length === 0) {
    return <p class="hint">No profiles yet. Rules you set here apply to this {kind} only.</p>;
  }
  return (
    <div class="chips">
      {ids.map((id) => {
        const selected = draft.extends.includes(id);
        const counts = tools.length ? tally(inheritedRules([id], profiles), tools) : null;
        const isDefault = id === defaultProfile;
        return (
          <Chip
            key={id}
            selected={selected || (isDefault && draft.inheritDefault)}
            title={
              isDefault
                ? 'Every agent inherits this default profile unless you turn it off'
                : undefined
            }
            onClick={() => {
              if (isDefault && !selected) {
                onChange({ ...draft, inheritDefault: !draft.inheritDefault });
                return;
              }
              onChange({
                ...draft,
                extends: selected ? draft.extends.filter((p) => p !== id) : [...draft.extends, id],
              });
            }}
          >
            <span class="chip-name">{id}</span>
            {isDefault && <span class="chip-note">default</span>}
            {counts && (
              <span class="chip-counts">
                {counts.allow > 0 && <span class="c-allow">{counts.allow}</span>}
                {counts.ask > 0 && <span class="c-ask">{counts.ask}</span>}
                {counts.deny > 0 && <span class="c-deny">{counts.deny}</span>}
              </span>
            )}
          </Chip>
        );
      })}
    </div>
  );
}

function ToolMatrix({
  draft,
  onChange,
  tools,
  effective,
  background,
  profiles,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  tools: Tool[];
  effective: Pick<Rules, 'allow' | 'ask' | 'deny'>;
  background: Pick<Rules, 'allow' | 'ask' | 'deny'>;
  profiles: Record<string, Profile>;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const q = query.trim().toLowerCase();
  const visible = q
    ? tools.filter((t) =>
        `${t.name} ${t.description} ${t.tags.join(' ')}`.toLowerCase().includes(q)
      )
    : tools;
  const groups = groupByProvider(visible);
  const ownExact = new Set([...draft.allow, ...draft.ask, ...draft.deny]);

  const sourceOf = (pattern?: string) => {
    if (!pattern) return undefined;
    if ([...draft.allow, ...draft.ask, ...draft.deny].includes(pattern))
      return `your rule ${pattern}`;
    const profile = Object.entries(profiles).find(([, p]) =>
      [...p.allow, ...p.ask, ...p.deny].includes(pattern)
    );
    return profile ? `${profile[0]} (${pattern})` : pattern;
  };

  if (tools.length === 0) {
    return <p class="hint">No tools found. Add a provider, then reload.</p>;
  }

  return (
    <div class="matrix">
      <div class="matrix-tools">
        <input
          type="search"
          class="search"
          placeholder={`Search ${tools.length} tools`}
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          aria-label="Search tools"
        />
        <Button
          size="sm"
          onClick={() => onChange({ ...draft, ...applyRecommended(draft, visible) })}
        >
          Use recommended{q ? ' for matches' : ''}
        </Button>
      </div>
      {groups.map(([provider, list]) => {
        const counts = tally(effective, list);
        const expanded = open[provider] ?? Boolean(q);
        const wide =
          (['allow', 'ask', 'deny'] as const).find((d) => draft[d].includes(`${provider}/*`)) ??
          null;
        return (
          <div class={cx('provider-group', expanded && 'is-open')} key={provider}>
            <div class="provider-row">
              <button
                type="button"
                class="provider-toggle"
                aria-expanded={expanded}
                onClick={() => setOpen({ ...open, [provider]: !expanded })}
              >
                <span class="caret" aria-hidden="true" />
                <span class="provider-name">{provider}</span>
                <span class="provider-count">{list.length} tools</span>
              </button>
              <TallyBar counts={counts} total={list.length} />
              <DecisionSwitch
                label={`All ${provider} tools`}
                own={wide}
                inherited="none"
                onChange={(decision) =>
                  onChange({ ...draft, ...setProviderWide(draft, provider, decision) })
                }
              />
            </div>
            {expanded && (
              <ul class="tool-list">
                {list.map((tool) => {
                  const own = ownExact.has(tool.name)
                    ? ((['allow', 'ask', 'deny'] as const).find((d) =>
                        draft[d].includes(tool.name)
                      ) as Decision)
                    : null;
                  const inherited = resolve(background, tool.name);
                  return (
                    <li class="tool" key={tool.name}>
                      <div class="tool-main">
                        <code class="tool-name">{tool.shortName}</code>
                        <ToolTags tool={tool} />
                        {tool.description && <p class="tool-desc">{tool.description}</p>}
                      </div>
                      <DecisionSwitch
                        label={tool.name}
                        own={own}
                        inherited={inherited.decision}
                        inheritedFrom={sourceOf(inherited.pattern)}
                        onChange={(decision) =>
                          onChange({ ...draft, ...setExact(draft, tool.name, decision) })
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ToolTags({ tool }: { tool: Tool }) {
  const tags = tool.tags.filter((t) => t !== 'idempotent');
  if (!tags.length) return null;
  return (
    <span class="tool-tags">
      {tags.map((tag) => (
        <span key={tag} class={cx('tag', `tag-${tag}`)}>
          {tag === 'readonly' ? 'read-only' : tag}
        </span>
      ))}
    </span>
  );
}
