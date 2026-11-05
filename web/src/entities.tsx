import { useEffect, useMemo, useState } from 'preact/hooks';
import { draftFromAgent, draftFromProfile, updateAgentSpec, updateProfileSpec } from './drafts';
import { effectiveRules, inheritedRules, tally } from './policy';
import { PolicyEditor, type Draft } from './policy-editor';
import { ReviewSheet } from './review';
import { go, goAfterSave, useStore, useUnsavedGuard } from './store';
import type { Agent, ChangeOp, Kind } from './types';
import { Button, Empty, TallyBar, cx } from './ui';

export function Roster({ kind }: { kind: Kind }) {
  const { state, tools, toolsLoaded, pending, setAssistantOpen, meta } = useStore();
  if (!state) return null;
  const isAgent = kind === 'agent';
  const entries = Object.entries(isAgent ? state.agents : state.profiles);
  const noun = isAgent ? 'agent' : 'profile';

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">{isAgent ? 'Agents' : 'Profiles'}</h1>
          <p class="lede">
            {isAgent
              ? 'Each agent is a client with its own key and rules.'
              : 'Reusable rule sets that agents build on.'}
          </p>
        </div>
        <div class="page-actions">
          {meta?.assistant.enabled && (
            <Button variant="quiet" onClick={() => setAssistantOpen(true)}>
              Describe one instead
            </Button>
          )}
          <Button variant="primary" onClick={() => go(isAgent ? 'agents' : 'profiles', 'new')}>
            New {noun}
          </Button>
        </div>
      </header>

      {entries.length === 0 ? (
        <Empty title={`No ${noun}s yet`}>
          <p>
            {isAgent
              ? 'Create one for each client that should reach your tools through Airlock.'
              : 'Profiles save you repeating the same rules across agents.'}
          </p>
          <Button variant="primary" onClick={() => go(isAgent ? 'agents' : 'profiles', 'new')}>
            New {noun}
          </Button>
        </Empty>
      ) : (
        <table class="roster">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Builds on</th>
              <th scope="col" class="col-access">
                Access
              </th>
              {isAgent && <th scope="col">Key</th>}
              {isAgent && (
                <th scope="col" class="col-num">
                  Waiting
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {entries.map(([id, entity]) => {
              const rules = isAgent
                ? effectiveRules(
                    entity,
                    state.profiles,
                    'inheritDefault' in entity && entity.inheritDefault
                      ? state.defaultProfile
                      : undefined
                  )
                : {
                    allow: [
                      ...inheritedRules(entity.extends, state.profiles).allow,
                      ...entity.allow,
                    ],
                    ask: [...inheritedRules(entity.extends, state.profiles).ask, ...entity.ask],
                    deny: [...inheritedRules(entity.extends, state.profiles).deny, ...entity.deny],
                  };
              const counts = tally(rules, tools);
              const waiting = pending.filter((p) => p.agentId === id).length;
              const href = `#/${isAgent ? 'agents' : 'profiles'}/${encodeURIComponent(id)}`;
              return (
                <tr key={id} onClick={() => (window.location.hash = href.slice(1))}>
                  <th scope="row">
                    <a href={href} class="roster-name">
                      {id}
                    </a>
                  </th>
                  <td class="roster-extends">
                    {entity.extends.length ? (
                      entity.extends.join(', ')
                    ) : (
                      <span class="dim">Nothing</span>
                    )}
                  </td>
                  <td class="col-access">
                    {toolsLoaded ? (
                      <div class="roster-access">
                        <TallyBar counts={counts} total={tools.length} />
                        <span class="roster-counts">
                          <span class="c-allow">{counts.allow}</span> allow,{' '}
                          <span class="c-ask">{counts.ask}</span> ask
                        </span>
                      </div>
                    ) : (
                      <span class="dim">Loading</span>
                    )}
                  </td>
                  {isAgent && (
                    <td>
                      {'hasToken' in entity && entity.hasToken ? (
                        <span class="key-state is-set">Set</span>
                      ) : (
                        <span class="key-state is-missing">None</span>
                      )}
                    </td>
                  )}
                  {isAgent && (
                    <td class="col-num">
                      {waiting ? (
                        <span class="waiting">{waiting}</span>
                      ) : (
                        <span class="dim">0</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function EntityPage({ kind, id }: { kind: Kind; id: string }) {
  const { state, tools, toast } = useStore();
  const entity = kind === 'agent' ? state?.agents[id] : state?.profiles[id];
  const original = useMemo<Draft | null>(() => {
    if (!entity) return null;
    return kind === 'agent' ? draftFromAgent(entity as Agent) : draftFromProfile(entity);
  }, [entity, kind]);
  const [draft, setDraft] = useState<Draft | null>(original);
  const [review, setReview] = useState<{
    ops: ChangeOp[];
    title: string;
    label: string;
    danger?: boolean;
    successMessage?: string;
  } | null>(null);

  useEffect(() => setDraft(original), [original]);
  const dirty = Boolean(draft && original) && JSON.stringify(draft) !== JSON.stringify(original);
  useUnsavedGuard(dirty);

  if (!state) return null;
  if (!entity || !draft || !original) {
    return (
      <div class="page">
        <Empty title={`No ${kind} called ${id}`}>
          <a href={kind === 'agent' ? '#/agents' : '#/profiles'}>Back to the list</a>
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
  const hasKey = kind === 'agent' && 'hasToken' in entity && entity.hasToken;
  const counts = tally(
    effectiveRules(
      draft,
      state.profiles,
      kind === 'agent' && draft.inheritDefault ? state.defaultProfile : undefined
    ),
    tools
  );

  const saveOps = (): ChangeOp[] =>
    kind === 'agent'
      ? [{ op: 'update_agent', id, agent: updateAgentSpec(original, draft) }]
      : [{ op: 'update_profile', id, profile: updateProfileSpec(original, draft) }];

  return (
    <div class="page entity">
      <a class="back" href={kind === 'agent' ? '#/agents' : '#/profiles'}>
        {kind === 'agent' ? 'Agents' : 'Profiles'}
      </a>
      <header class="page-head">
        <div>
          <h1 class="page-title">{id}</h1>
          <div class="entity-facts">
            {kind === 'agent' && (
              <span class={cx('key-state', hasKey ? 'is-set' : 'is-missing')}>
                {hasKey ? 'Key set' : 'No key. It falls back to the gateway secret.'}
              </span>
            )}
            {kind === 'agent' && (
              <span class="fact">
                <code>/agents/{id}/mcp</code>
              </span>
            )}
            {kind === 'profile' && (
              <span class="fact">
                {usedBy.length ? `Used by ${usedBy.join(', ')}` : 'Not used yet'}
              </span>
            )}
            {tools.length > 0 && (
              <span class="fact">
                {counts.allow} allow, {counts.ask} ask, {counts.deny + counts.none} blocked
              </span>
            )}
          </div>
        </div>
        <div class="page-actions">
          {kind === 'agent' && (
            <Button
              onClick={() =>
                setReview({
                  ops: [{ op: 'rotate_agent_key', id }],
                  title: hasKey ? `Rotate the key for ${id}` : `Give ${id} a key`,
                  label: hasKey ? 'Rotate key' : 'Create key',
                })
              }
            >
              {hasKey ? 'Rotate key' : 'Create key'}
            </Button>
          )}
          <Button
            variant="quiet"
            onClick={() => go(kind === 'agent' ? 'agents' : 'profiles', 'new', id)}
            title={`New ${kind} with the same rules`}
          >
            Duplicate
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              setReview({
                ops: [{ op: kind === 'agent' ? 'delete_agent' : 'delete_profile', id }],
                title: `Delete ${id}`,
                label: `Delete ${kind}`,
                danger: true,
                successMessage: `Deleted ${id}.`,
              })
            }
          >
            Delete
          </Button>
        </div>
      </header>

      <PolicyEditor kind={kind} selfId={id} draft={draft} onChange={setDraft} />

      <div class={cx('savebar', dirty && 'is-visible')} aria-hidden={!dirty}>
        <span>Unsaved changes to {id}</span>
        <Button variant="quiet" onClick={() => setDraft(original)} tabIndex={dirty ? 0 : -1}>
          Discard
        </Button>
        <Button
          variant="primary"
          tabIndex={dirty ? 0 : -1}
          onClick={() => setReview({ ops: saveOps(), title: `Save ${id}`, label: 'Save changes' })}
        >
          Review and save
        </Button>
      </div>

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
            if (review.ops[0].op.startsWith('delete'))
              goAfterSave(kind === 'agent' ? 'agents' : 'profiles');
          }}
        />
      )}
    </div>
  );
}
