import { useState } from 'preact/hooks';
import { KeyRound, RotateCw } from 'lucide-preact';
import { useStore } from './store';
import type { Grant } from './types';
import {
  Button,
  Empty,
  SearchInput,
  cx,
  formatCountdown,
  formatGrantScope,
  fullTime,
  plural,
  relativeTime,
  remainingFraction,
  useNow,
} from './ui';

const SOURCE_LABEL: Record<string, string> = {
  approval: 'Approval',
  plan: 'Plan',
  async: 'Async retry',
  operator: 'Operator',
};

export function GrantsPage() {
  const { state, grants, canRevokeGrants, revokeGrant, refreshGrants } = useStore();
  const now = useNow(1000);
  const [agent, setAgent] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = grants.filter((g) => {
    if (agent && g.agentId !== agent) return false;
    if (!q) return true;
    const scope = formatGrantScope(g.scope);
    return `${g.agentId} ${scope.kindLabel} ${scope.target} ${g.label ?? ''} ${g.source}`
      .toLowerCase()
      .includes(q);
  });
  const agentIds = Array.from(
    new Set([...Object.keys(state?.agents ?? {}), ...grants.map((g) => g.agentId)])
  ).sort();

  return (
    <>
      <header class="topbar">
        <div class="topbar-title">
          <h1>Grants</h1>
          <span class="topbar-meta">
            {grants.length ? `${grants.length} active` : 'None active'}
          </span>
        </div>
        <div class="topbar-actions">
          <Button
            variant="ghost"
            icon
            busy={busy}
            aria-label="Refresh grants"
            title="Refresh"
            onClick={async () => {
              setBusy(true);
              try {
                await refreshGrants();
              } finally {
                setBusy(false);
              }
            }}
          >
            <RotateCw size={14} aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div class="page">
        {grants.length === 0 ? (
          <Empty title="No active grants" icon={<KeyRound size={22} aria-hidden="true" />}>
            <p>
              Time-boxed and single-use permissions from approvals, plans, and async retries show up
              here until they expire or you revoke them.
            </p>
          </Empty>
        ) : (
          <>
            <div class="toolbar">
              <SearchInput
                value={query}
                onInput={setQuery}
                placeholder="Search scope or tool"
                label="Search grants"
              />
              {agentIds.length > 1 && (
                <select
                  class="select"
                  value={agent}
                  onChange={(e) => setAgent(e.currentTarget.value)}
                  aria-label="Filter by agent"
                >
                  <option value="">All agents</option>
                  {agentIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {filtered.length === 0 ? (
              <Empty title="No grants match">
                <Button
                  size="sm"
                  onClick={() => {
                    setQuery('');
                    setAgent('');
                  }}
                >
                  Clear filters
                </Button>
              </Empty>
            ) : (
              <div class="table-scroll">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">Scope</th>
                      <th scope="col">Agent</th>
                      <th scope="col" class="hide-sm">
                        Source
                      </th>
                      <th scope="col" class="hide-sm">
                        Uses left
                      </th>
                      <th scope="col">Expires</th>
                      {canRevokeGrants && (
                        <th scope="col" class="col-actions">
                          <span class="visually-hidden">Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((grant) => (
                      <GrantRow
                        key={grant.id}
                        grant={grant}
                        now={now}
                        canRevoke={canRevokeGrants}
                        busy={revoking === grant.id}
                        onRevoke={async () => {
                          setRevoking(grant.id);
                          try {
                            await revokeGrant(grant.id);
                          } finally {
                            setRevoking(null);
                          }
                        }}
                      />
                    ))}
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

function GrantRow({
  grant,
  now,
  canRevoke,
  busy,
  onRevoke,
}: {
  grant: Grant;
  now: number;
  canRevoke: boolean;
  busy: boolean;
  onRevoke: () => void;
}) {
  const scope = formatGrantScope(grant.scope);
  const countdown = formatCountdown(grant.expiresAt, now);
  const fraction = remainingFraction(grant.createdAt, grant.expiresAt, now);
  return (
    <tr>
      <td>
        <code class="tool">{scope.target}</code>
        <span class="scope-kind">
          {scope.kindLabel}
          {grant.label ? ` · ${grant.label}` : ''}
        </span>
      </td>
      <td>
        <a class="link" href={`#/agents/${encodeURIComponent(grant.agentId)}`}>
          {grant.agentId}
        </a>
      </td>
      <td class="hide-sm ink-2" title={`Created ${fullTime(grant.createdAt)}`}>
        {SOURCE_LABEL[grant.source] ?? grant.source}
        <span class="cell-sub">{relativeTime(grant.createdAt, now)}</span>
      </td>
      <td class="hide-sm num ink-2">
        {grant.usesRemaining !== undefined ? plural(grant.usesRemaining, 'use') : 'Unlimited'}
      </td>
      <td>
        {countdown ? (
          <span
            class={cx('time-left', countdown.urgent && 'is-urgent')}
            title={grant.expiresAt ? fullTime(grant.expiresAt) : undefined}
          >
            {countdown.label}
            {fraction !== null && (
              <span class="track" aria-hidden="true">
                <span style={{ transform: `scaleX(${fraction})` }} />
              </span>
            )}
          </span>
        ) : (
          <span class="ink-3">No expiry</span>
        )}
      </td>
      {canRevoke && (
        <td class="col-actions">
          <Button
            size="sm"
            variant="ghost"
            class="btn-revoke"
            busy={busy}
            onClick={onRevoke}
            aria-label={`Revoke ${scope.target} for ${grant.agentId}`}
          >
            Revoke
          </Button>
        </td>
      )}
    </tr>
  );
}
