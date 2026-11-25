import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { ChevronRight, RotateCw } from 'lucide-preact';
import {
  applyRecommended,
  effectiveRules,
  explainResolution,
  groupByProvider,
  inheritedRules,
  resolve,
  setExact,
  setProviderWide,
  tally,
} from './policy';
import { useStore } from './store';
import type { Decision, Kind, Profile, Resolved, Rules, Tool } from './types';
import {
  AccessBar,
  Button,
  DecisionSwitch,
  ListInput,
  Notice,
  SearchInput,
  ToolCode,
  cx,
  plural,
} from './ui';

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
    return { effective, background, defaultProfile };
  }, [kind, draft, state]);
}

const DECISION_TITLE: Record<Decision, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };

export function PolicyEditor({
  kind,
  selfId,
  draft,
  onChange,
  aside,
}: {
  kind: Kind;
  selfId?: string;
  draft: Draft;
  onChange: (draft: Draft) => void;
  aside?: ComponentChildren;
}) {
  const { state, tools, toolsLoaded, toolsLoading, toolErrors, refreshTools } = useStore();
  const profiles = state?.profiles ?? {};
  const { effective, background, defaultProfile } = useEffective(kind, draft);
  const counts = useMemo(() => tally(effective, tools), [effective, tools]);
  const hasExec = tools.some((t) => t.name === 'exec/run') || Boolean(state?.providers.exec);
  const execBlocked =
    ['none', 'deny'].includes(resolve(effective, 'exec/run').decision) &&
    draft.exec.allow.length + draft.exec.ask.length + draft.exec.deny.length > 0;
  const hasHttp = tools.some((t) => t.provider === 'http') || Boolean(state?.providers.http);

  return (
    <div class="policy-layout">
      <div class="policy">
        <section class="policy-section">
          <div class="policy-section-head">
            <div>
              <h2>Inherits</h2>
              <p>Profiles are shared rule sets. Rules below override them by specificity.</p>
            </div>
          </div>
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
          <div class="policy-section-head">
            <div>
              <h2>Tools</h2>
              <p>
                Allow runs right away, Ask waits for you, Deny blocks. Anything unmatched is
                blocked.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              busy={toolsLoading}
              onClick={() => refreshTools()}
              title="Ask each provider for its tools again"
            >
              <RotateCw size={13} aria-hidden="true" />
              Reload
            </Button>
          </div>
          {toolErrors.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <Notice tone="warn">
                <ul>
                  {toolErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}
          {!toolsLoaded ? (
            <div aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ padding: '14px 0', borderTop: '1px solid var(--line)' }}>
                  <span class="skeleton" style={{ width: `${40 - i * 8}%` }} />
                </div>
              ))}
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
          <details class="disclosure">
            <summary>
              <ChevronRight size={13} aria-hidden="true" />
              Raw patterns
            </summary>
            <div class="disclosure-body">
              <p class="field-help" style={{ marginBottom: '12px' }}>
                <code>github/*</code> matches every GitHub tool and <code>github/list*</code> a
                prefix. The most specific pattern wins; ties go deny, then ask, then allow.
              </p>
              <div class="pattern-grid">
                {(['allow', 'ask', 'deny'] as const).map((decision) => (
                  <ListInput
                    key={decision}
                    tone={decision}
                    label={DECISION_TITLE[decision]}
                    placeholder="provider/tool"
                    values={draft[decision]}
                    onChange={(values) => onChange({ ...draft, [decision]: values })}
                  />
                ))}
              </div>
            </div>
          </details>
        </section>

        {kind === 'agent' && hasExec && (
          <section class="policy-section">
            <div class="policy-section-head">
              <div>
                <h2>Shell commands</h2>
                <p>
                  Narrow what <code>exec/run</code> may execute by command prefix. Leave empty to
                  use the tool rule alone.
                </p>
              </div>
            </div>
            {execBlocked && (
              <div style={{ marginBottom: '12px' }}>
                <Notice tone="warn">
                  <code>exec/run</code> is blocked for this agent, so these rules do nothing. Set it
                  to Allow or Ask above.
                </Notice>
              </div>
            )}
            <div class="pattern-grid">
              {(['allow', 'ask', 'deny'] as const).map((decision) => (
                <ListInput
                  key={decision}
                  tone={decision}
                  label={DECISION_TITLE[decision]}
                  placeholder={
                    decision === 'deny'
                      ? 'rm -rf*'
                      : decision === 'ask'
                        ? 'git push*'
                        : 'git status*'
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
            <div class="policy-section-head">
              <div>
                <h2>Web requests</h2>
                <p>Domains the HTTP tool may reach. Empty means no extra domain restriction.</p>
              </div>
            </div>
            <ListInput
              label="Allowed domains"
              placeholder="api.github.com"
              values={draft.http.domainAllowlist}
              onChange={(values) => onChange({ ...draft, http: { domainAllowlist: values } })}
            />
          </section>
        )}

        {kind === 'agent' && (
          <section class="policy-section">
            <div class="policy-section-head">
              <div>
                <h2>While you decide</h2>
                <p>What the agent gets back when a call needs your approval.</p>
              </div>
            </div>
            <div class="radio-list" role="radiogroup" aria-label="Approval mode">
              {(
                [
                  [null, 'Gateway default', 'Follow approvals.mode in the config.'],
                  ['sync', 'Hold the call', 'The tool call waits until you approve or deny it.'],
                  [
                    'async',
                    'Answer right away',
                    'Returns “approval pending” at once so the agent can retry later.',
                  ],
                ] as const
              ).map(([value, title, body]) => (
                <label class="radio-option" key={String(value)}>
                  <input
                    type="radio"
                    name="approval-mode"
                    checked={draft.approvalMode === value}
                    onChange={() => onChange({ ...draft, approvalMode: value })}
                  />
                  <strong>{title}</strong>
                  <span>{body}</span>
                </label>
              ))}
            </div>
          </section>
        )}
      </div>

      <aside class="policy-aside" aria-label="Effective access">
        <div class="aside-block">
          <h3>Effective access</h3>
          {tools.length > 0 ? (
            <>
              <div class="posture">
                <div>
                  <span class="dot is-allow" aria-hidden="true" />
                  <strong>{counts.allow}</strong> allow
                </div>
                <div>
                  <span class="dot is-ask" aria-hidden="true" />
                  <strong>{counts.ask}</strong> ask
                </div>
                <div>
                  <span class="dot is-deny" aria-hidden="true" />
                  <strong>{counts.deny}</strong> deny
                </div>
                <div>
                  <span class="dot" aria-hidden="true" />
                  <strong>{counts.none}</strong> unmatched
                </div>
              </div>
              <AccessBar counts={counts} total={tools.length} />
              <p class="field-help">Across {plural(tools.length, 'tool')} from your providers.</p>
            </>
          ) : (
            <p class="field-help">Counts appear once providers report their tools.</p>
          )}
        </div>
        <AccessSimulator
          draft={draft}
          profiles={profiles}
          defaultProfile={defaultProfile}
          tools={tools}
          selfLabel={selfId ? `${kind} ${selfId}` : `this ${kind}`}
        />
        {aside}
      </aside>
    </div>
  );
}

function AccessSimulator({
  draft,
  profiles,
  defaultProfile,
  tools,
  selfLabel,
}: {
  draft: Draft;
  profiles: Record<string, Profile>;
  defaultProfile?: string;
  tools: Tool[];
  selfLabel: string;
}) {
  const [probe, setProbe] = useState('');
  const result = useMemo(
    () =>
      probe.trim() ? explainResolution(draft, profiles, probe, defaultProfile, selfLabel) : null,
    [draft, profiles, probe, defaultProfile, selfLabel]
  );
  const verdict =
    result?.decision === 'none'
      ? 'Blocked'
      : result
        ? DECISION_TITLE[result.decision as Decision]
        : '';

  return (
    <div class="aside-block simulator">
      <h3>Test a tool</h3>
      <label class="search">
        <span class="visually-hidden">Tool name to test</span>
        <input
          type="search"
          class="input is-mono"
          list="airlock-tool-list"
          value={probe}
          spellcheck={false}
          autocomplete="off"
          placeholder="github/delete_repo"
          style={{ paddingLeft: '10px' }}
          onInput={(e) => setProbe(e.currentTarget.value)}
        />
      </label>
      <datalist id="airlock-tool-list">
        {tools.map((t) => (
          <option key={t.name} value={t.name} />
        ))}
      </datalist>
      {result ? (
        <div class="sim-result" aria-live="polite">
          <div class={cx('sim-verdict', `is-${result.decision}`)}>
            <span
              class={cx(
                'dot',
                result.decision === 'allow'
                  ? 'is-allow'
                  : result.decision === 'ask'
                    ? 'is-ask'
                    : 'is-deny'
              )}
              aria-hidden="true"
            />
            {verdict}
          </div>
          <p class="sim-reason">{result.reason}</p>
          {result.matches.length > 0 && (
            <ul class="sim-matches">
              {result.matches.map((m, i) => (
                <li key={i} class={cx(!m.isWinner && 'is-loser')}>
                  <span class={cx('dec', `c-${m.decision}`)}>{m.decision}</span>
                  <code>{m.pattern}</code>
                  <span class="src">
                    {m.source}
                    {m.exact ? ', exact' : `, specificity ${m.score}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p class="field-help" style={{ marginTop: '8px' }}>
          See which rule decides a tool, including inherited profiles and tie-breaks.
        </p>
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
    return <p class="field-help">No profiles yet. Rules here apply to this {kind} only.</p>;
  }
  return (
    <div class="toggle-list" role="group" aria-label="Inherited profiles">
      {ids.map((id) => {
        const explicit = draft.extends.includes(id);
        const isDefault = id === defaultProfile;
        const selected = explicit || (isDefault && draft.inheritDefault);
        const counts = tools.length ? tally(inheritedRules([id], profiles), tools) : null;
        return (
          <label class="toggle-row" key={id}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => {
                if (isDefault && !explicit) {
                  onChange({ ...draft, inheritDefault: !draft.inheritDefault });
                  return;
                }
                onChange({
                  ...draft,
                  extends: explicit
                    ? draft.extends.filter((p) => p !== id)
                    : [...draft.extends, id],
                });
              }}
            />
            <span>
              <span class="name">{id}</span>
              {isDefault && <span class="toggle-note">Default for every agent</span>}
            </span>
            {counts && (
              <span class="access-counts">
                <span>
                  <strong>{counts.allow}</strong> allow
                </span>
                <span>
                  <strong>{counts.ask}</strong> ask
                </span>
                {counts.deny > 0 && (
                  <span>
                    <strong>{counts.deny}</strong> deny
                  </span>
                )}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

type MatrixFilter = 'all' | Resolved | 'risky';

const RISKY = ['destructive', 'injection', 'open-world'];

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
  const [filter, setFilter] = useState<MatrixFilter>('all');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const q = query.trim().toLowerCase();

  const visible = useMemo(
    () =>
      tools.filter((t) => {
        if (q && !`${t.name} ${t.description} ${t.tags.join(' ')}`.toLowerCase().includes(q))
          return false;
        if (filter === 'all') return true;
        if (filter === 'risky') return t.tags.some((tag) => RISKY.includes(tag));
        return resolve(effective, t.name).decision === filter;
      }),
    [tools, q, filter, effective]
  );

  const groups = groupByProvider(visible);
  const ownExact = new Set([...draft.allow, ...draft.ask, ...draft.deny]);
  const filtering = Boolean(q) || filter !== 'all';
  const allExpanded = groups.length > 0 && groups.every(([p]) => open[p] ?? filtering);

  const sourceOf = (pattern?: string) => {
    if (!pattern) return undefined;
    if (ownExact.has(pattern) || [...draft.allow, ...draft.ask, ...draft.deny].includes(pattern))
      return `your rule ${pattern}`;
    const profile = Object.entries(profiles).find(([, p]) =>
      [...p.allow, ...p.ask, ...p.deny].includes(pattern)
    );
    return profile ? `${profile[0]} (${pattern})` : pattern;
  };

  if (tools.length === 0) {
    return <p class="field-help">No tools found. Add a provider, then reload.</p>;
  }

  return (
    <div class="matrix">
      <div class="matrix-bar">
        <SearchInput
          value={query}
          onInput={setQuery}
          placeholder={`Search ${plural(tools.length, 'tool')}`}
          label="Search tools"
        />
        <select
          class="select"
          value={filter}
          aria-label="Show tools"
          onChange={(e) => setFilter(e.currentTarget.value as MatrixFilter)}
        >
          <option value="all">All tools</option>
          <option value="allow">Allowed</option>
          <option value="ask">Ask first</option>
          <option value="deny">Denied</option>
          <option value="none">Unmatched</option>
          <option value="risky">Risky</option>
        </select>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const next: Record<string, boolean> = {};
            for (const [provider] of groups) next[provider] = !allExpanded;
            setOpen(next);
          }}
        >
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </Button>
        <Button
          size="sm"
          onClick={() => onChange({ ...draft, ...applyRecommended(draft, visible) })}
          title="Set each tool to Airlock's suggestion from its annotations"
        >
          Use recommended{filtering ? ' for these' : ''}
        </Button>
      </div>

      {groups.length === 0 ? (
        <p class="field-help" style={{ padding: '12px 0' }}>
          No tools match.
        </p>
      ) : (
        groups.map(([provider, list]) => {
          const counts = tally(effective, list);
          const expanded = open[provider] ?? filtering;
          const wide =
            (['allow', 'ask', 'deny'] as const).find((d) => draft[d].includes(`${provider}/*`)) ??
            null;
          return (
            <div class="prov-group" key={provider}>
              <div class="prov-row">
                <button
                  type="button"
                  class="prov-toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpen({ ...open, [provider]: !expanded })}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                  <span class="name">{provider}</span>
                  <span class="count">{plural(list.length, 'tool')}</span>
                </button>
                <AccessBar counts={counts} total={list.length} />
                <DecisionSwitch
                  label={`Every ${provider} tool`}
                  own={wide}
                  inherited="none"
                  onChange={(decision) =>
                    onChange({ ...draft, ...setProviderWide(draft, provider, decision) })
                  }
                />
              </div>
              {expanded && (
                <ul class="tool-rows">
                  {list.map((tool) => {
                    const own = ownExact.has(tool.name)
                      ? ((['allow', 'ask', 'deny'] as const).find((d) =>
                          draft[d].includes(tool.name)
                        ) ?? null)
                      : null;
                    const inherited = resolve(background, tool.name);
                    const tags = tool.tags.filter((t) => t !== 'idempotent');
                    return (
                      <li class="tool-row" key={tool.name}>
                        <div class="tool-row-main">
                          <div class="tool-row-name">
                            <ToolCode tool={tool.shortName} />
                            {tags.length > 0 && (
                              <span class="tool-row-tags">
                                {tags.map((tag, i) => (
                                  <>
                                    {i > 0 && ', '}
                                    <span class={cx(RISKY.includes(tag) && 'is-risk')}>
                                      {tag === 'readonly' ? 'read-only' : tag}
                                    </span>
                                  </>
                                ))}
                              </span>
                            )}
                          </div>
                          {tool.description && (
                            <p class="tool-row-desc" title={tool.description}>
                              {tool.description}
                            </p>
                          )}
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
        })
      )}
    </div>
  );
}
