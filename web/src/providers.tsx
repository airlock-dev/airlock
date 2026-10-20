import { useState } from 'preact/hooks';
import { api } from './api';
import { useStore } from './store';
import type { Provider } from './types';
import { Button, Empty, Sheet, cx } from './ui';

interface ProviderForm {
  id: string;
  type: Provider['type'];
  command: string;
  args: string;
  url: string;
  oauth: boolean;
  isNew: boolean;
}

export function Providers() {
  const { state, status, setState, refreshStatus, refreshTools, toast } = useStore();
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  if (!state) return null;
  const entries = Object.entries(state.providers);

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
      const next = await api.saveProvider({
        id: form.id.trim(),
        type: form.type,
        command: form.command,
        args: form.args
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean),
        url: form.url,
        oauth: form.type === 'http' ? form.oauth : undefined,
      });
      setForm(null);
      await after(next, `Saved provider ${form.id.trim()}.`);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Providers</h1>
          <p class="lede">
            The MCP servers and built-in tools Airlock puts in front of your agents.
          </p>
        </div>
        <div class="page-actions">
          <Button onClick={() => refreshStatus()}>Check again</Button>
          <Button
            variant="primary"
            onClick={() =>
              setForm({
                id: '',
                type: 'stdio',
                command: '',
                args: '',
                url: '',
                oauth: false,
                isNew: true,
              })
            }
          >
            Add provider
          </Button>
        </div>
      </header>

      {entries.length === 0 ? (
        <Empty title="No providers yet">
          <p>Add an MCP server so agents have tools to call.</p>
        </Empty>
      ) : (
        <table class="roster providers">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Health</th>
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
              const health = !provider.enabled ? 'disabled' : (runtime?.status ?? 'unknown');
              return (
                <tr key={id} class={cx(!provider.enabled && 'is-off')}>
                  <th scope="row">
                    <span class="roster-name">{id}</span>
                    <span class="dim provider-detail">
                      {provider.type === 'stdio'
                        ? [provider.command, ...(provider.args ?? [])].join(' ')
                        : (provider.url ?? '')}
                    </span>
                  </th>
                  <td>{provider.type}</td>
                  <td>
                    <span class={cx('health', `is-${health}`)} title={runtime?.error ?? undefined}>
                      {health === 'ok'
                        ? 'Up'
                        : health === 'down'
                          ? 'Down'
                          : health === 'disabled'
                            ? 'Off'
                            : 'Checking'}
                    </span>
                    {runtime?.error && health === 'down' && (
                      <span class="provider-error">{runtime.error}</span>
                    )}
                  </td>
                  <td class="col-num">{runtime?.toolCount ?? 0}</td>
                  <td class="col-actions">
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={async () => {
                        try {
                          const next = await api.saveProvider({
                            id,
                            type: provider.type,
                            enabled: !provider.enabled,
                          });
                          await after(
                            next,
                            `${provider.enabled ? 'Turned off' : 'Turned on'} ${id}.`
                          );
                        } catch (e) {
                          toast((e as Error).message, 'error');
                        }
                      }}
                      aria-label={`${provider.enabled ? 'Turn off' : 'Turn on'} ${id}`}
                    >
                      {provider.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                    {provider.type !== 'builtin' && (
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() =>
                          setForm({
                            id,
                            type: provider.type,
                            command: provider.command ?? '',
                            args: (provider.args ?? []).join('\n'),
                            url: provider.url ?? '',
                            oauth: Boolean(provider.oauth),
                            isNew: false,
                          })
                        }
                        aria-label={`Edit ${id}`}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="quiet"
                      aria-label={`Remove ${id}`}
                      onClick={() => setConfirmDelete(id)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {form && (
        <Sheet
          open
          onClose={() => {
            setForm(null);
            setFormError(null);
          }}
          title={form.isNew ? 'Add provider' : `Edit ${form.id}`}
          footer={
            <>
              <Button variant="quiet" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button variant="primary" busy={busy} onClick={save}>
                {form.isNew ? 'Add provider' : 'Save provider'}
              </Button>
            </>
          }
        >
          <div class="form">
            {formError && <p class="notice notice-error">{formError}</p>}
            <label class="field">
              <span class="field-label">Name</span>
              <input
                value={form.id}
                disabled={!form.isNew}
                placeholder="github"
                onInput={(e) => setForm({ ...form, id: e.currentTarget.value })}
              />
              <span class="field-help">
                Tools appear as name/tool, for example github/create_issue.
              </span>
            </label>
            <fieldset class="field">
              <legend class="field-label">How Airlock reaches it</legend>
              <div class="choice-row">
                {(
                  [
                    ['stdio', 'Local command', 'Airlock starts the server as a process.'],
                    ['http', 'HTTP', 'Streamable HTTP endpoint.'],
                    ['sse', 'SSE', 'Older server-sent events endpoint.'],
                  ] as const
                ).map(([type, title, body]) => (
                  <button
                    type="button"
                    class={cx('choice', form.type === type && 'is-selected')}
                    aria-pressed={form.type === type}
                    onClick={() => setForm({ ...form, type })}
                  >
                    <strong>{title}</strong>
                    <span>{body}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            {form.type === 'stdio' ? (
              <>
                <label class="field">
                  <span class="field-label">Command</span>
                  <input
                    value={form.command}
                    placeholder="npx"
                    onInput={(e) => setForm({ ...form, command: e.currentTarget.value })}
                  />
                </label>
                <label class="field">
                  <span class="field-label">Arguments, one per line</span>
                  <textarea
                    rows={4}
                    value={form.args}
                    placeholder={'-y\n@modelcontextprotocol/server-github'}
                    onInput={(e) => setForm({ ...form, args: e.currentTarget.value })}
                  />
                  <span class="field-help">
                    Environment variables and secrets stay in the YAML file.
                  </span>
                </label>
              </>
            ) : (
              <>
                <label class="field">
                  <span class="field-label">URL</span>
                  <input
                    value={form.url}
                    placeholder="https://mcp.example.com/mcp"
                    onInput={(e) => setForm({ ...form, url: e.currentTarget.value })}
                  />
                </label>
                {form.type === 'http' && (
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={form.oauth}
                      onChange={(e) => setForm({ ...form, oauth: e.currentTarget.checked })}
                    />
                    Sign in with OAuth
                  </label>
                )}
              </>
            )}
          </div>
        </Sheet>
      )}

      {confirmDelete && (
        <Sheet
          open
          onClose={() => setConfirmDelete(null)}
          title={`Remove ${confirmDelete}?`}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirmDelete(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    const next = await api.deleteProvider(confirmDelete);
                    setConfirmDelete(null);
                    await after(next, `Removed ${confirmDelete}.`);
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
          <p>
            Agents lose its tools. Rules that mention it stay in the config until you remove them.
          </p>
        </Sheet>
      )}
    </div>
  );
}
