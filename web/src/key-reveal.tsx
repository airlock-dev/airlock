import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore, type RevealedKey } from './store';
import { Button, CopyButton } from './ui';

const GATEWAY_URL_KEY = 'airlock:gatewayUrl';

function storedGatewayUrl(): string {
  try {
    return localStorage.getItem(GATEWAY_URL_KEY) ?? '';
  } catch {
    return '';
  }
}

function guessGatewayUrl(): string {
  return `${window.location.protocol}//${window.location.hostname}:4111`;
}

type ClientId = 'claude' | 'codex' | 'openclaw' | 'json' | 'curl';

const CLIENTS: { id: ClientId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'json', label: 'MCP JSON' },
  { id: 'curl', label: 'curl' },
];

function snippet(
  client: ClientId,
  base: string,
  agentId: string,
  key: string
): { text: string; note: string } {
  const root = base.replace(/\/+$/, '');
  const url = `${root}/agents/${agentId}/mcp`;
  const name = `airlock-${agentId}`;
  const envVar = `AIRLOCK_KEY_${agentId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  switch (client) {
    case 'claude':
      return {
        note: 'Run once on the machine where Claude Code runs.',
        text: `claude mcp add --transport http ${name} ${url} \\\n  --header "Authorization: Bearer ${key}"`,
      };
    case 'codex':
      return {
        note: 'Add to ~/.codex/config.toml, and export the key where Codex runs.',
        text: `[mcp_servers.${name.replace(/[^A-Za-z0-9_-]/g, '_')}]\nurl = "${url}"\nbearer_token_env_var = "${envVar}"\n\n# in your shell profile\nexport ${envVar}=${key}`,
      };
    case 'openclaw':
      return {
        note: 'Configures the airlock-bridge plugin. AIRLOCK_URL, AIRLOCK_AGENT and AIRLOCK_SECRET in its environment take precedence.',
        text: `openclaw config set extensions.airlock-bridge.url ${root}\nopenclaw config set extensions.airlock-bridge.agent ${agentId}\nopenclaw config set extensions.airlock-bridge.secret ${key}`,
      };
    case 'json':
      return {
        note: 'For .mcp.json, Cursor, and other clients that take an mcpServers block.',
        text: JSON.stringify(
          {
            mcpServers: {
              [name]: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } },
            },
          },
          null,
          2
        ),
      };
    case 'curl':
      return {
        note: 'Checks the key works. Expect a JSON-RPC result with serverInfo.',
        text: `curl -sS ${url} \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'`,
      };
  }
}

export function KeyReveal() {
  const { revealed, dismissReveal } = useStore();
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [revealed]);
  if (!revealed.length) return null;
  const current = revealed[Math.min(index, revealed.length - 1)];
  const last = index >= revealed.length - 1;
  return (
    <Hatch
      key={current.agentId}
      item={current}
      position={revealed.length > 1 ? `${index + 1} of ${revealed.length}` : undefined}
      onDone={() => (last ? dismissReveal() : setIndex(index + 1))}
      doneLabel={last ? 'Done' : 'Next key'}
    />
  );
}

function Hatch({
  item,
  onDone,
  doneLabel,
  position,
}: {
  item: RevealedKey;
  onDone: () => void;
  doneLabel: string;
  position?: string;
}) {
  const { meta } = useStore();
  const [client, setClient] = useState<ClientId>('claude');
  const [saved, setSaved] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState(
    () => meta?.publicGatewayUrl || storedGatewayUrl() || guessGatewayUrl()
  );
  const keyRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const configuredUrl = Boolean(meta?.publicGatewayUrl);
  const { text, note } = snippet(client, gatewayUrl, item.agentId, item.key);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const finish = () => {
    if (!saved && !confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    onDone();
  };

  return (
    <div class="scrim is-dialog" style={{ paddingTop: '8vh' }}>
      <div
        class="sheet reveal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reveal-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => e.key === 'Escape' && finish()}
      >
        <header class="sheet-head">
          <div class="sheet-head-text">
            <h2 id="reveal-title">
              {item.rotated ? 'New key for' : 'Key for'} {item.agentId}
              {position ? <span class="ink-3"> · {position}</span> : null}
            </h2>
            <p class="sheet-sub">
              Shown once. Airlock keeps only a hash.
              {item.rotated ? ' The previous key has stopped working.' : ''}
            </p>
          </div>
        </header>

        <div class="sheet-body">
          <div class="key-plate">
            <code ref={keyRef} class="key-value" onClick={() => selectText(keyRef.current)}>
              {item.key}
            </code>
            <CopyButton
              value={item.key}
              label="Copy key"
              variant="primary"
              onCopied={() => setSaved(true)}
            />
          </div>

          <section>
            <div class="connect-head">
              <h3>Connect a client</h3>
              <label class="gateway-url">
                <span>Gateway</span>
                <input
                  class="input"
                  name="gateway-url"
                  type="url"
                  autocomplete="off"
                  value={gatewayUrl}
                  spellcheck={false}
                  readOnly={configuredUrl}
                  title={
                    configuredUrl
                      ? 'Set by --public-url'
                      : 'Remembered in this browser. Set --public-url on the dashboard to fix it for everyone.'
                  }
                  onInput={(e) => {
                    const value = e.currentTarget.value;
                    setGatewayUrl(value);
                    try {
                      localStorage.setItem(GATEWAY_URL_KEY, value);
                    } catch {
                      // Storage is optional.
                    }
                  }}
                />
              </label>
            </div>
            <div class="segmented" role="tablist" aria-label="Client">
              {CLIENTS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={client === c.id}
                  onClick={() => setClient(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div class="snippet" role="tabpanel">
              <pre class="code-block">{text}</pre>
              <div class="snippet-foot">
                <span>{note}</span>
                <CopyButton value={text} onCopied={() => setSaved(true)} />
              </div>
            </div>
          </section>
        </div>

        <footer class="sheet-foot">
          <label class="check" style={{ marginRight: 'auto' }}>
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.currentTarget.checked)}
            />
            I stored this key somewhere safe
          </label>
          <Button
            variant={saved ? 'primary' : confirmLeave ? 'danger' : 'default'}
            onClick={finish}
          >
            {saved || !confirmLeave ? doneLabel : 'Close without the key'}
          </Button>
        </footer>
        {confirmLeave && !saved ? (
          <p class="reveal-warn" style={{ padding: '0 20px 14px', textAlign: 'right' }}>
            Closing loses this key for good. You can rotate a new one from the agent page.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function selectText(node: HTMLElement | null) {
  if (!node) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
