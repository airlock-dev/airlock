import { useEffect, useMemo, useState } from 'preact/hooks';
import { Bot, ChevronRight, Ellipsis, Layers, Plus, Sparkles } from 'lucide-preact';
import { draftFromAgent, draftFromProfile, updateAgentSpec, updateProfileSpec } from './drafts';
import { effectiveRules, inheritedRules, tally } from './policy';
import { PolicyEditor, type Draft } from './policy-editor';
import { ReviewSheet } from './review';
import { go, goAfterSave, useStore, useUnsavedGuard } from './store';
import type { Agent, ChangeOp, Kind } from './types';
import { AccessBar, AccessCounts, Button, Empty, Menu, SearchInput, plural } from './ui';

export function Roster({ kind }: { kind: Kind }) {
  const { state, tools, toolsLoaded, pending, grants, setAssistantOpen, meta } = useStore();
  const [query, setQuery] = useState('');
  if (!state) return null;
  const isAgent = kind === 'agent';
  const section = isAgent ? 'agents' : 'profiles';
  const noun = isAgent ? 'agent' : 'profile';
  const all = Object.entries(isAgent ? state.agents : state.profiles);
  const q = query.trim().toLowerCase();
  const entries = q
    ? all.filter(([id, entity]) =>
        `${id} ${entity.extends.join(' ')} ${entity.allow.join(' ')} ${entity.ask.join(' ')}`
          .toLowerCase()
          .includes(q)
      )
    : all;

  return (
    <>
      <header class="topbar">
        <div class="topbar-title">
          <h1>{isAgent ? 'Agents' : 'Profiles'}</h1>
          <span class="topbar-meta">{all.length || ''}</span>
        </div>
        <div class="topbar-actions">
          {meta?.assistant.enabled && (
            <Button variant="ghost" onClick={() => setAssistantOpen(true)}>
              <Sparkles size={14} aria-hidden="true" />
              Describe it
            </Button>
          )}
          <Button variant="primary" onClick={() => go(section, 'new')}>
            <Plus size={14} aria-hidden="true" />
            New {noun}
          </Button>
        </div>
      </header>

      <div class="page">
        <p class="lede" style={{ marginBottom: '20px' }}>
          {isAgent
            ? 'Each agent is one client with its own key, approval mode, and tool policy.'
            : 'Reusable rule sets that agents and other profiles inherit.'}
        </p>

        {all.length === 0 ? (
          <Empty
            title={`No ${noun}s yet`}
            icon={
              isAgent ? (
                <Bot size={22} aria-hidden="true" />
              ) : (
                <Layers size={22} aria-hidden="true" />
              )
            }
          >
            <p>
              {isAgent
                ? 'Create one for each client that should reach your tools through Airlock.'
                : 'Profiles save you repeating the same rules across agents.'}
            </p>
            <Button variant="primary" onClick={() => go(section, 'new')}>
              New {noun}
            </Button>
          </Empty>
        ) : (
          <>
            {all.length > 5 && (
              <div class="toolbar">
                <SearchInput
                  value={query}
                  onInput={setQuery}
                  placeholder={`Search ${noun}s`}
                  label={`Search ${noun}s`}
                />
              </div>
            )}
            {entries.length === 0 ? (
              <Empty title={`No ${noun}s match “${query}”`}>
                <Button size="sm" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              </Empty>
            ) : (
              <div class="table-scroll">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col" class="hide-sm">
                        Inherits
                      </th>
                      <th scope="col" style={{ width: '34%' }}>
                        Access
                      </th>
                      {isAgent && (
                        <th scope="col" class="hide-sm">
                          Key
                        </th>
                      )}
                      <th scope="col" class="col-actions">
                        <span class="visually-hidden">Open</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(([id, entity]) => {
                      const rules = isAgent
                        ? effectiveRules(
                            entity,
                            state.profiles,
                            (entity as Agent).inheritDefault ? state.defaultProfile : undefined
                          )
                        : (() => {
                            const inherited = inheritedRules(entity.extends, state.profiles);
                            return {
                              allow: [...inherited.allow, ...entity.allow],
                              ask: [...inherited.ask, ...entity.ask],
                              deny: [...inherited.deny, ...entity.deny],
                            };
                          })();
                      const counts = tally(rules, tools);
                      const waiting = pending.filter((p) => p.agentId === id).length;
                      const agentGrants = grants.filter((g) => g.agentId === id).length;
                      const usedBy = !isAgent
                        ? Object.values(state.agents).filter((a) => a.extends.includes(id)).length +
                          Object.values(state.profiles).filter((p) => p.extends.includes(id)).length
                        : 0;
                      const href = `#/${section}/${encodeURIComponent(id)}`;
                      const sub = isAgent
                        ? [
                            waiting > 0 && `${waiting} waiting`,
                            agentGrants > 0 && plural(agentGrants, 'grant'),
                            (entity as Agent).approvalMode &&
                              {
                                hybrid: 'Waits, then pending',
                                sync: 'Holds calls',
                                async: 'Answers right away',
                              }[(entity as Agent).approvalMode!],
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : [
                            state.defaultProfile === id && 'Default',
                            usedBy > 0 ? `Used by ${usedBy}` : 'Not used yet',
                          ]
                            .filter(Boolean)
                            .join(' · ');
                      return (
                        <tr
                          key={id}
                          class="is-clickable"
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('a')) return;
                            window.location.hash = href.slice(1);
                          }}
                        >
                          <th scope="row">
                            <a href={href} class="cell-title">
                              {id}
                            </a>
                            {sub && (
                              <span class="cell-sub">
                                {waiting > 0 && (
                                  <span
                                    class="dot is-ask"
                                    style={{ marginRight: '6px' }}
                                    aria-hidden="true"
                                  />
                                )}
                                {sub}
                              </span>
                            )}
                          </th>
                          <td class="hide-sm ink-2">
                            {entity.extends.length ? (
                              entity.extends.join(', ')
                            ) : (
                              <span class="ink-3">—</span>
                            )}
                          </td>
                          <td>
                            {toolsLoaded ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                <AccessCounts counts={counts} />
                                <AccessBar counts={counts} total={tools.length} />
                              </div>
                            ) : (
                              <span class="skeleton" style={{ width: '70%' }} />
                            )}
                          </td>
                          {isAgent && (
                            <td class="hide-sm">
                              {(entity as Agent).hasToken ? (
                                <span class="ink-2">Own key</span>
                              ) : (
                                <span class="ink-3">Gateway secret</span>
                              )}
                            </td>
                          )}
                          <td class="col-actions ink-3">
                            <ChevronRight size={14} aria-hidden="true" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

interface PendingReview {
  ops: ChangeOp[];
  title: string;
  label: string;
  danger?: boolean;
  successMessage?: string;
}

export function EntityPage({ kind, id }: { kind: Kind; id: string }) {
  const { state, pending, grants } = useStore();
  const entity = kind === 'agent' ? state?.agents[id] : state?.profiles[id];
  const original = useMemo<Draft | null>(() => {
    if (!entity) return null;
    return kind === 'agent' ? draftFromAgent(entity as Agent) : draftFromProfile(entity);
  }, [entity, kind]);
  const [draft, setDraft] = useState<Draft | null>(original);
  const [review, setReview] = useState<PendingReview | null>(null);

  useEffect(() => setDraft(original), [original]);
  const dirty = Boolean(draft && original) && JSON.stringify(draft) !== JSON.stringify(original);
  useUnsavedGuard(dirty);

  const section = kind === 'agent' ? 'agents' : 'profiles';

  if (!state) return null;
  if (!entity || !draft || !original) {
    return (
      <div class="page">
        <Empty title={`No ${kind} called ${id}`}>
          <a class="link" href={`#/${section}`}>
            Back to {section}
          </a>
        </Empty>
      </div>
    );
  }

  const usedBy =
    kind === 'profile'
      ? [
          ...Object.entries(state.agents)
            .filter(([, a]) => a.extends.includes(id))
            .map(([a]) => a),
          ...Object.entries(state.profiles)
            .filter(([, p]) => p.extends.includes(id))
            .map(([p]) => `${p} (profile)`),
        ]
      : [];
  const hasKey = kind === 'agent' && (entity as Agent).hasToken;
  const waiting = pending.filter((p) => p.agentId === id).length;
  const agentGrants = grants.filter((g) => g.agentId === id).length;

  const saveOps = (): ChangeOp[] =>
    kind === 'agent'
      ? [{ op: 'update_agent', id, agent: updateAgentSpec(original, draft) }]
      : [{ op: 'update_profile', id, profile: updateProfileSpec(original, draft) }];

  return (
    <>
      <header class="topbar">
        <nav class="crumb" aria-label="Breadcrumb">
          <a href={`#/${section}`}>{kind === 'agent' ? 'Agents' : 'Profiles'}</a>
          <ChevronRight size={13} aria-hidden="true" />
          <span class="current" aria-current="page">
            {id}
          </span>
        </nav>
        <div class="topbar-actions">
          {kind === 'agent' && (
            <Button
              onClick={() =>
                setReview({
                  ops: [{ op: 'rotate_agent_key', id }],
                  title: hasKey ? `Rotate the key for ${id}` : `Give ${id} its own key`,
                  label: hasKey ? 'Rotate key' : 'Create key',
                })
              }
            >
              {hasKey ? 'Rotate key' : 'Create key'}
            </Button>
          )}
          <Menu
            label={`${id} actions`}
            trigger={(props) => (
              <Button {...props} icon aria-label={`More actions for ${id}`}>
                <Ellipsis size={15} aria-hidden="true" />
              </Button>
            )}
            items={[
              {
                id: 'duplicate',
                label: `Duplicate ${kind}`,
                sub: 'Start a new one with the same rules',
                onSelect: () => go(section, 'new', id),
              },
              {
                id: 'delete',
                label: `Delete ${kind}`,
                danger: true,
                separatorBefore: true,
                onSelect: () =>
                  setReview({
                    ops: [{ op: kind === 'agent' ? 'delete_agent' : 'delete_profile', id }],
                    title: `Delete ${id}`,
                    label: `Delete ${kind}`,
                    danger: true,
                    successMessage: `Deleted ${id}`,
                  }),
              },
            ]}
          />
        </div>
      </header>

      <div class="page">
        <div class="entity-head">
          <div>
            <h1>{id}</h1>
            <p class="entity-meta">
              {kind === 'agent' ? (
                <>
                  <code>/agents/{id}/mcp</code>
                  <span class="sep">·</span>
                  <span class="key-state">
                    <span class={hasKey ? 'dot is-ok' : 'dot is-ask'} aria-hidden="true" />
                    {hasKey ? 'Own key' : 'No key, uses the gateway secret'}
                  </span>
                  {waiting > 0 && (
                    <>
                      <span class="sep">·</span>
                      <a class="link" href="#/inbox">
                        {waiting} waiting
                      </a>
                    </>
                  )}
                  {agentGrants > 0 && (
                    <>
                      <span class="sep">·</span>
                      <a class="link" href="#/grants">
                        {plural(agentGrants, 'active grant')}
                      </a>
                    </>
                  )}
                </>
              ) : (
                <span>
                  {usedBy.length ? `Used by ${usedBy.join(', ')}` : 'Not inherited by anything yet'}
                  {state.defaultProfile === id && ' · Default for every agent'}
                </span>
              )}
            </p>
          </div>
        </div>

        <PolicyEditor kind={kind} selfId={id} draft={draft} onChange={setDraft} />
      </div>

      {dirty && (
        <div class="savebar" role="region" aria-label="Unsaved changes">
          <span class="savebar-text">Unsaved changes</span>
          <Button variant="ghost" onClick={() => setDraft(original)}>
            Discard
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              setReview({ ops: saveOps(), title: `Save ${id}`, label: 'Save to airlock.yaml' })
            }
          >
            Review changes
          </Button>
        </div>
      )}

      {review && (
        <ReviewSheet
          open
          ops={review.ops}
          title={review.title}
          applyLabel={review.label}
          danger={review.danger}
          successMessage={review.successMessage}
          note={
            review.danger && usedBy.length > 0 ? (
              <>
                {id} is used by {usedBy.join(', ')}. Remove it from them first, then delete it.
              </>
            ) : undefined
          }
          onClose={() => setReview(null)}
          onApplied={() => {
            if (review.ops[0].op.startsWith('delete')) goAfterSave(section);
          }}
        />
      )}
    </>
  );
}
