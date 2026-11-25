import { useEffect, useState } from 'preact/hooks';
import { Ellipsis, Plus, RotateCw, Server } from 'lucide-preact';
import { api } from './api';
import { useStore } from './store';
import type { Provider } from './types';
import { Button, Empty, KeyValueEditor, Menu, Notice, SearchInput, Sheet, cx, plural } from './ui';

interface KvRow {
  key: string;
  value: string;
}

interface ProviderForm {
  id: string;
  type: Provider['type'];
  enabled: boolean;
  command: string;
  args: string;
  env: KvRow[];
  url: string;
  headers: KvRow[];
  oauth: boolean;
  bearerTokenFile: string;
  isNew: boolean;
}

function recordToRows(rec?: Record<string, string>): KvRow[] {
  return rec ? Object.entries(rec).map(([key, value]) => ({ key, value })) : [];
}

function rowsToRecord(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return out;
}

function blankForm(): ProviderForm {
  return {
    id: '',
    type: 'stdio',
    enabled: true,
    command: '',
    args: '',
    env: [],
    url: '',
    headers: [],
    oauth: false,
    bearerTokenFile: '',
    isNew: true,
  };
}

function formFor(id: string, provider: Provider): ProviderForm {
  return {
    id,
    type: provider.type,
    enabled: provider.enabled,
    command: provider.command ?? '',
    args: (provider.args ?? []).join('\n'),
    env: recordToRows(provider.env),
    url: provider.url ?? '',
    headers: recordToRows(provider.headers),
    oauth: Boolean(provider.oauth),
    bearerTokenFile: provider.bearerTokenFile ?? '',
    isNew: false,
  };
}

const TRANSPORT: Record<Provider['type'], string> = {
  builtin: 'Built-in',
  stdio: 'Local process',
  http: 'HTTP',
  sse: 'SSE',
};

export function Providers() {
  const { state, status, setState, refreshStatus, refreshTools, toast } = useStore();
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onNew = () => setForm(blankForm());
    window.addEventListener('airlock:new-provider', onNew);
    return () => window.removeEventListener('airlock:new-provider', onNew);
  }, []);

  if (!state) return null;
  const all = Object.entries(state.providers);
  const q = query.trim().toLowerCase();
  const entries = q
    ? all.filter(([id, p]) =>
        `${id} ${p.type} ${p.command ?? ''} ${p.url ?? ''}`.toLowerCase().includes(q)
      )
    : all;

  const after = async (next: typeof state, message: string) => {
    setState(next);
    toast(message);
    refreshStatus().catch(() => {});
    refreshTools().catch(() => {});
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    try {
      const payload: Record<string, unknown> = {
        id: form.id.trim(),
        type: form.type,
        enabled: form.enabled,
      };
      if (form.type === 'stdio') {
        payload.command = form.command;
        payload.args = form.args
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean);
        payload.env = rowsToRecord(form.env);
      } else if (form.type === 'http' || form.type === 'sse') {
        payload.url = form.url;
        payload.headers = rowsToRecord(form.headers);
        if (form.type === 'http') {
          payload.oauth = form.oauth;
          payload.bearer_token_file = form.bearerTokenFile.trim();
        }
      }
      const next = await api.saveProvider(payload);
      setForm(null);
      await after(next, `Saved ${form.id.trim()}`);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string, provider: Provider) => {
    try {
      const next = await api.saveProvider({ id, type: provider.type, enabled: !provider.enabled });
      await after(next, `${provider.enabled ? 'Disabled' : 'Enabled'} ${id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const down = status?.summary.down ?? 0;

  return (
    <>
      <header class="topbar">
        <div class="topbar-title">
          <h1>Providers</h1>
          <span class="topbar-meta">
            {status ? (
              <>
                {plural(status.summary.tools, 'tool')}
                {down > 0 && (
                  <>
                    <span class="sep">·</span>
                    <span class="c-deny">{down} down</span>
                  </>
                )}
              </>
            ) : (
              all.length || ''
            )}
          </span>
        </div>
        <div class="topbar-actions">
          <Button
            variant="ghost"
            busy={checking}
            onClick={async () => {
              setChecking(true);
              try {
                await Promise.all([refreshStatus(), refreshTools()]);
              } finally {
                setChecking(false);
              }
            }}
          >
            <RotateCw size={14} aria-hidden="true" />
            Check health
          </Button>
          <Button variant="primary" onClick={() => setForm(blankForm())}>
            <Plus size={14} aria-hidden="true" />
            Add provider
          </Button>
        </div>
      </header>

      <div class="page">
        {all.length === 0 ? (
          <Empty title="No providers yet" icon={<Server size={22} aria-hidden="true" />}>
            <p>Add an MCP server or a built-in provider so agents have tools to call.</p>
            <Button variant="primary" onClick={() => setForm(blankForm())}>
              Add provider
            </Button>
          </Empty>
        ) : (
          <>
            {all.length > 6 && (
              <div class="toolbar">
                <SearchInput
                  value={query}
                  onInput={setQuery}
                  placeholder="Filter providers"
                  label="Filter providers"
                />
              </div>
            )}
            {entries.length === 0 ? (
              <Empty title={`No providers match “${query}”`}>
                <Button size="sm" onClick={() => setQuery('')}>
                  Clear filter
                </Button>
              </Empty>
            ) : (
              <div class="table-scroll">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col" class="hide-sm">
                        Transport
                      </th>
                      <th scope="col">Status</th>
                      <th scope="col" class="col-num">
                        Tools
                      </th>
                      <th scope="col" class="col-actions">
                        <span class="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(([id, provider]) => {
                      const runtime = status?.providers.find((p) => p.id === id);
                      const health = !provider.enabled
                        ? 'disabled'
                        : (runtime?.status ?? 'unknown');
                      const envCount = Object.keys(provider.env ?? {}).length;
                      const headerCount = Object.keys(provider.headers ?? {}).length;
                      const detail =
                        provider.type === 'stdio'
                          ? [provider.command, ...(provider.args ?? [])].join(' ')
                          : provider.type === 'builtin'
                            ? 'Runs inside the gateway'
                            : (provider.url ?? '');
                      const extras = [
                        provider.oauth && 'OAuth',
                        envCount > 0 && plural(envCount, 'env var'),
                        headerCount > 0 && plural(headerCount, 'header'),
                      ].filter(Boolean);
                      return (
                        <tr key={id} class={cx(!provider.enabled && 'is-off')}>
                          <th scope="row" style={{ maxWidth: 0, width: '50%' }}>
                            <span class="prov-name">
                              <span class="cell-title">{id}</span>
                              {runtime?.serverInfo && (
                                <span class="ink-3" style={{ fontSize: '12px' }}>
                                  {runtime.serverInfo.name} {runtime.serverInfo.version}
                                </span>
                              )}
                            </span>
                            <span class="prov-detail" title={detail}>
                              {detail}
                              {extras.length > 0 && (
                                <span style={{ fontFamily: 'var(--font)' }}>
                                  {'  ·  '}
                                  {extras.join(' · ')}
                                </span>
                              )}
                            </span>
                            {runtime?.error && (health === 'down' || health === 'degraded') && (
                              <span class="prov-error">{runtime.error}</span>
                            )}
                          </th>
                          <td class="hide-sm ink-2">{TRANSPORT[provider.type]}</td>
                          <td>
                            <span
                              class="result"
                              style={{
                                color:
                                  health === 'down'
                                    ? 'var(--deny-ink)'
                                    : health === 'degraded'
                                      ? 'var(--ask-ink)'
                                      : undefined,
                              }}
                            >
                              <span
                                class={cx(
                                  'dot',
                                  health === 'ok' && 'is-ok',
                                  (health === 'down' || health === 'degraded') && 'is-down',
                                  health === 'disabled' && 'is-off'
                                )}
                                aria-hidden="true"
                              />
                              {health === 'ok'
                                ? 'Healthy'
                                : health === 'degraded'
                                  ? 'Degraded'
                                  : health === 'down'
                                    ? 'Down'
                                    : health === 'disabled'
                                      ? 'Disabled'
                                      : 'Checking…'}
                            </span>
                          </td>
                          <td class="col-num ink-2">
                            {health === 'disabled' ? '—' : (runtime?.toolCount ?? '—')}
                          </td>
                          <td class="col-actions">
                            <span style={{ display: 'inline-flex', gap: '4px' }}>
                              {provider.type !== 'builtin' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setForm(formFor(id, provider))}
                                  aria-label={`Edit ${id}`}
                                >
                                  Edit
                                </Button>
                              )}
                              <Menu
                                label={`${id} actions`}
                                trigger={(props) => (
                                  <Button
                                    {...props}
                                    size="sm"
                                    variant="ghost"
                                    icon
                                    aria-label={`More actions for ${id}`}
                                  >
                                    <Ellipsis size={14} aria-hidden="true" />
                                  </Button>
                                )}
                                items={[
                                  {
                                    id: 'toggle',
                                    label: provider.enabled ? 'Disable' : 'Enable',
                                    sub: provider.enabled
                                      ? 'Agents lose its tools until you turn it back on'
                                      : 'Start it with the gateway again',
                                    onSelect: () => void toggle(id, provider),
                                  },
                                  {
                                    id: 'remove',
                                    label: 'Remove provider',
                                    danger: true,
                                    separatorBefore: true,
                                    onSelect: () => setConfirmDelete(id),
                                  },
                                ]}
                              />
                            </span>
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

      {form && (
        <Sheet
          open
          onClose={() => {
            setForm(null);
            setFormError(null);
          }}
          title={form.isNew ? 'Add provider' : `Edit ${form.id}`}
          subtitle="Saved to airlock.yaml. Use ${VAR} to reference secrets from the gateway's environment."
          footer={
            <>
              <label class="check" style={{ marginRight: 'auto' }}>
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })}
                />
                Enabled
              </label>
              <Button
                variant="ghost"
                onClick={() => {
                  setForm(null);
                  setFormError(null);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" busy={busy} onClick={save}>
                {form.isNew ? 'Add provider' : 'Save provider'}
              </Button>
            </>
          }
        >
          <div class="form">
            {formError && <Notice tone="error">{formError}</Notice>}
            <label class="field">
              <span class="field-label">ID</span>
              <input
                class="input is-mono"
                name="provider-id"
                value={form.id}
                disabled={!form.isNew}
                placeholder="github…"
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => setForm({ ...form, id: e.currentTarget.value })}
              />
              <span class="field-help">
                Its tools are named <code>{form.id || 'id'}/tool</code>.
              </span>
            </label>

            <fieldset class="field">
              <legend class="field-label" style={{ marginBottom: '6px' }}>
                Transport
              </legend>
              <div class="radio-list" role="radiogroup">
                {(
                  [
                    ['stdio', 'Local process', 'Airlock starts an MCP server command.'],
                    ['http', 'Streamable HTTP', 'A remote MCP server over HTTP.'],
                    ['sse', 'Server-sent events', 'An older remote MCP endpoint.'],
                  ] as const
                ).map(([type, title, body]) => (
                  <label class="radio-option" key={type}>
                    <input
                      type="radio"
                      name="transport"
                      checked={form.type === type}
                      onChange={() => setForm({ ...form, type })}
                    />
                    <strong>{title}</strong>
                    <span>{body}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {form.type === 'stdio' ? (
              <>
                <label class="field">
                  <span class="field-label">Command</span>
                  <input
                    class="input is-mono"
                    name="command"
                    value={form.command}
                    placeholder="npx…"
                    autocomplete="off"
                    spellcheck={false}
                    onInput={(e) => setForm({ ...form, command: e.currentTarget.value })}
                  />
                </label>
                <label class="field">
                  <span class="field-label">Arguments</span>
                  <textarea
                    class="textarea is-mono"
                    name="args"
                    rows={3}
                    value={form.args}
                    spellcheck={false}
                    placeholder={'-y\n@modelcontextprotocol/server-github'}
                    onInput={(e) => setForm({ ...form, args: e.currentTarget.value })}
                  />
                  <span class="field-help">One per line.</span>
                </label>
                <div class="field">
                  <span class="field-label">Environment</span>
                  <KeyValueEditor
                    label="Variable"
                    rows={form.env}
                    onChange={(env) => setForm({ ...form, env })}
                    keyPlaceholder="GITHUB_TOKEN"
                    valuePlaceholder="${GITHUB_TOKEN}"
                    addLabel="Add variable"
                  />
                </div>
              </>
            ) : (
              <>
                <label class="field">
                  <span class="field-label">URL</span>
                  <input
                    class="input is-mono"
                    type="url"
                    name="url"
                    value={form.url}
                    placeholder="https://mcp.example.com/mcp…"
                    autocomplete="off"
                    spellcheck={false}
                    onInput={(e) => setForm({ ...form, url: e.currentTarget.value })}
                  />
                </label>
                {form.type === 'http' && (
                  <>
                    <label class="check">
                      <input
                        type="checkbox"
                        checked={form.oauth}
                        onChange={(e) => setForm({ ...form, oauth: e.currentTarget.checked })}
                      />
                      Sign in with OAuth
                    </label>
                    <label class="field">
                      <span class="field-label">Bearer token file (optional)</span>
                      <input
                        class="input is-mono"
                        name="bearer-token-file"
                        value={form.bearerTokenFile}
                        placeholder="/config/secrets/provider.token"
                        autocomplete="off"
                        spellcheck={false}
                        onInput={(e) =>
                          setForm({ ...form, bearerTokenFile: e.currentTarget.value })
                        }
                      />
                      <span class="field-help">
                        Path to a file containing a single bearer token (mutually exclusive with
                        OAuth or an Authorization header).
                      </span>
                    </label>
                  </>
                )}
                <div class="field">
                  <span class="field-label">Headers</span>
                  <KeyValueEditor
                    label="Header"
                    rows={form.headers}
                    onChange={(headers) => setForm({ ...form, headers })}
                    keyPlaceholder="Authorization"
                    valuePlaceholder="Bearer ${API_TOKEN}"
                    addLabel="Add header"
                  />
                </div>
              </>
            )}
          </div>
        </Sheet>
      )}

      {confirmDelete && (
        <Sheet
          open
          dialog
          onClose={() => setConfirmDelete(null)}
          title={`Remove ${confirmDelete}?`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    const next = await api.deleteProvider(confirmDelete);
                    setConfirmDelete(null);
                    await after(next, `Removed ${confirmDelete}`);
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                Remove provider
              </Button>
            </>
          }
        >
          <p class="ink-2">
            Agents lose its tools immediately. Rules that mention <code>{confirmDelete}/*</code>{' '}
            stay in airlock.yaml until you remove them.
          </p>
        </Sheet>
      )}
    </>
  );
}
