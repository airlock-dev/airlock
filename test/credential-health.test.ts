import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CredentialHealthMonitor } from '../src/pool/credential-health.js';
import { CredentialProbeConfig } from '../src/config/schema.js';
import type { ClientPool } from '../src/pool/pool.js';
import type { ProviderConnectionStatus } from '../src/pool/status.js';

// The failure this whole module exists for: a Google Workspace sidecar whose refresh token had
// been dead for ~24 days kept answering MCP, so mcpHealth said `ok` the entire time nobody could
// read mail. Reachability and credential validity are independent facts; these tests pin that the
// monitor never conflates them.

function probe(overrides: Partial<CredentialProbeConfig> = {}): CredentialProbeConfig {
  return CredentialProbeConfig.parse({ tool: 'whoami', ...overrides });
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

interface FakePoolOptions {
  ids?: string[];
  connection?: ProviderConnectionStatus;
  ready?: boolean;
  callTool?: (id: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  oauth?: boolean;
  listTools?: (id: string) => Promise<unknown>;
}

function fakePool(options: FakePoolOptions = {}) {
  const callTool = vi.fn(options.callTool ?? (async () => textResult('ok')));
  const listTools = vi.fn(options.listTools ?? (async () => []));
  const pool = {
    getMcpIds: () => options.ids ?? ['gwsPersonal'],
    getProviderConnectionStatus: () => options.connection ?? ({ status: 'up' } as const),
    isReady: () => options.ready ?? true,
    isOAuthProvider: () => options.oauth ?? false,
    callTool,
    listTools,
  } as unknown as ClientPool;
  return { pool, callTool, listTools };
}

describe('CredentialHealthMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports ok when the probe succeeds', async () => {
    const { pool } = fakePool();
    const monitor = new CredentialHealthMonitor(pool, { gwsPersonal: probe() });

    await monitor.prime();

    const health = monitor.snapshot().gwsPersonal;
    expect(health.status).toBe('ok');
    expect(health.source).toBe('probe');
    expect(health.checkedAt).toBeTypeOf('string');
  });

  it('says unknown — not ok — for a connected provider with no probe configured', () => {
    const { pool } = fakePool();
    const monitor = new CredentialHealthMonitor(pool, {});

    const health = monitor.snapshot().gwsPersonal;
    // The whole point: transport-up is not credential-valid, and we refuse to imply it is.
    expect(health.status).toBe('unknown');
    expect(health.reason).toBe('no credential_probe configured');
  });

  it('automatically probes every Airlock-managed OAuth provider with listTools', async () => {
    const { pool, listTools, callTool } = fakePool({ oauth: true });
    const monitor = new CredentialHealthMonitor(pool, {});

    await monitor.prime();

    expect(monitor.snapshot().gwsPersonal).toMatchObject({ status: 'ok', source: 'probe' });
    expect(listTools).toHaveBeenCalledWith('gwsPersonal');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('reports auth_required when the automatic OAuth probe is rejected', async () => {
    const { pool } = fakePool({
      oauth: true,
      listTools: async () => {
        throw new Error('401 Unauthorized');
      },
    });
    const monitor = new CredentialHealthMonitor(pool, {});

    await monitor.prime();

    expect(monitor.snapshot().gwsPersonal.status).toBe('auth_required');
  });

  it('trusts the transport when Airlock holds the OAuth itself', () => {
    const { pool, callTool } = fakePool({
      connection: { status: 'auth_required', reason: 'OAuth authorization required' },
    });
    const monitor = new CredentialHealthMonitor(pool, {});

    const health = monitor.snapshot().gwsPersonal;
    expect(health).toMatchObject({
      status: 'auth_required',
      source: 'connection',
      reason: 'OAuth authorization required',
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('classifies an auth-shaped thrown error as auth_required', async () => {
    const { pool } = fakePool({
      callTool: async () => {
        throw new Error('Token has been expired or revoked (invalid_grant)');
      },
    });
    const monitor = new CredentialHealthMonitor(pool, { gwsPersonal: probe() });

    await monitor.prime();

    expect(monitor.snapshot().gwsPersonal.status).toBe('auth_required');
  });

  it('classifies a non-auth failure as error, so a broken tool is not mistaken for a dead token', async () => {
    const { pool } = fakePool({
      callTool: async () => {
        throw new Error('Unknown tool: whoami');
      },
    });
    const monitor = new CredentialHealthMonitor(pool, { gwsPersonal: probe() });

    await monitor.prime();

    const health = monitor.snapshot().gwsPersonal;
    expect(health.status).toBe('error');
    expect(health.reason).toContain('Unknown tool');
  });

  it('treats an isError result as a failure and reads its text', async () => {
    const { pool } = fakePool({ callTool: async () => textResult('401 Unauthorized', true) });
    const monitor = new CredentialHealthMonitor(pool, { gwsPersonal: probe() });

    await monitor.prime();

    expect(monitor.snapshot().gwsPersonal.status).toBe('auth_required');
  });

  it('catches a provider that reports a dead credential as a SUCCESSFUL response', async () => {
    // The Google sidecar does exactly this: HTTP 200, isError unset, body is a re-auth prompt.
    const { pool } = fakePool({
      callTool: async () => textResult('**ACTION REQUIRED**: Please authorize Gmail access.'),
    });
    const monitor = new CredentialHealthMonitor(pool, {
      gwsPersonal: probe({ expect_contains: 'Found' }),
    });

    await monitor.prime();

    const health = monitor.snapshot().gwsPersonal;
    expect(health.status).toBe('auth_required');
    expect(health.reason).toContain('did not contain');
  });

  it('does not trip expect_contains on a healthy response', async () => {
    const { pool } = fakePool({ callTool: async () => textResult('Found 1 messages:\nID: abc') });
    const monitor = new CredentialHealthMonitor(pool, {
      gwsPersonal: probe({ expect_contains: 'Found' }),
    });

    await monitor.prime();

    expect(monitor.snapshot().gwsPersonal.status).toBe('ok');
  });

  it('supports reject_contains for providers with no stable success marker', async () => {
    const { pool } = fakePool({ callTool: async () => textResult('ACTION REQUIRED: reauthorize') });
    const monitor = new CredentialHealthMonitor(pool, {
      gwsPersonal: probe({ reject_contains: 'ACTION REQUIRED' }),
    });

    await monitor.prime();

    expect(monitor.snapshot().gwsPersonal.status).toBe('auth_required');
  });

  it('reports a disconnected provider as unknown, not as a credential failure', async () => {
    const { pool, callTool } = fakePool({
      ready: false,
      connection: { status: 'down', reason: 'ECONNREFUSED' },
    });
    const monitor = new CredentialHealthMonitor(pool, { gwsPersonal: probe() });

    await monitor.prime();

    const health = monitor.snapshot().gwsPersonal;
    // mcpHealth already says `down`; saying auth_required here would double-count it and page
    // someone about a credential that may well be fine.
    expect(health.status).toBe('unknown');
    expect(health.reason).toContain('not connected');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('times out a hanging probe instead of wedging /health', async () => {
    const { pool } = fakePool({ callTool: () => new Promise(() => {}) });
    const monitor = new CredentialHealthMonitor(pool, {
      gwsPersonal: probe({ timeout_ms: 1_000 }),
    });

    const primed = monitor.prime();
    await vi.advanceTimersByTimeAsync(1_100);
    await primed;

    const health = monitor.snapshot().gwsPersonal;
    expect(health.status).toBe('error');
    expect(health.reason).toContain('timed out');
  });

  it('serves from cache within the TTL and refreshes once it lapses', async () => {
    const { pool, callTool } = fakePool();
    const monitor = new CredentialHealthMonitor(pool, {
      gwsPersonal: probe({ interval_ms: 60_000 }),
    });

    await monitor.prime();
    expect(callTool).toHaveBeenCalledTimes(1);

    // A caller polling /health hard must not turn into API calls.
    for (let i = 0; i < 20; i++) monitor.snapshot();
    expect(callTool).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_001);
    monitor.snapshot(); // stale → kicks off a background refresh
    await vi.advanceTimersByTimeAsync(0);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into a single in-flight probe', async () => {
    let resolveCall: (value: unknown) => void = () => {};
    const { pool, callTool } = fakePool({
      callTool: () => new Promise((resolve) => (resolveCall = resolve)),
    });
    const monitor = new CredentialHealthMonitor(pool, { gwsPersonal: probe() });

    monitor.snapshot();
    monitor.snapshot();
    monitor.snapshot();
    expect(callTool).toHaveBeenCalledTimes(1);

    resolveCall(textResult('ok'));
  });

  it('returns unknown while the first probe is still in flight', () => {
    const { pool } = fakePool({ callTool: () => new Promise(() => {}) });
    const monitor = new CredentialHealthMonitor(pool, { gwsPersonal: probe() });

    const health = monitor.snapshot().gwsPersonal;
    expect(health.status).toBe('unknown');
    expect(health.reason).toContain('not completed');
  });

  it('drops a cached verdict when the probe definition changes', async () => {
    const { pool } = fakePool();
    const monitor = new CredentialHealthMonitor(pool, { gwsPersonal: probe() });

    await monitor.prime();
    expect(monitor.snapshot().gwsPersonal.status).toBe('ok');

    monitor.reload({ gwsPersonal: probe({ tool: 'something_else' }) });
    // A verdict earned by the old probe says nothing about the new one.
    expect(monitor.snapshot().gwsPersonal.status).toBe('unknown');
  });

  it('passes the configured tool and args through verbatim', async () => {
    const { pool, callTool } = fakePool();
    const monitor = new CredentialHealthMonitor(pool, {
      gwsPersonal: probe({
        tool: 'search_gmail_messages',
        args: { query: 'label:x', page_size: 1 },
      }),
    });

    await monitor.prime();

    expect(callTool).toHaveBeenCalledWith('gwsPersonal', 'search_gmail_messages', {
      query: 'label:x',
      page_size: 1,
    });
  });

  it('covers every pooled provider, probed or not', () => {
    const { pool } = fakePool({ ids: ['gwsPersonal', 'gwsWork', 'github'] });
    const monitor = new CredentialHealthMonitor(pool, {});

    expect(Object.keys(monitor.snapshot()).sort()).toEqual(['github', 'gwsPersonal', 'gwsWork']);
  });
});

describe('credential_probe config', () => {
  it('defaults the TTL to 15 minutes', () => {
    expect(CredentialProbeConfig.parse({ tool: 'whoami' }).interval_ms).toBe(900_000);
  });

  it('floors the TTL at a minute so /health polling cannot burn an API quota', () => {
    expect(() => CredentialProbeConfig.parse({ tool: 'whoami', interval_ms: 1_000 })).toThrow();
  });

  it('rejects unknown keys rather than silently ignoring a typo', () => {
    expect(() => CredentialProbeConfig.parse({ tool: 'whoami', expect: 'Found' })).toThrow();
  });
});
