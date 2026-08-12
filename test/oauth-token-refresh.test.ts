import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileOAuthProvider } from '../src/pool/oauth-provider.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

// Prevent actual browser opens
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

describe('FileOAuthProvider — refresh_token preservation', () => {
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'airlock-oauth-refresh-'));
    process.env.HOME = tempHome;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  const initial: OAuthTokens = {
    access_token: 'access-1',
    token_type: 'Bearer',
    refresh_token: 'refresh-1',
    expires_in: 3600,
  };

  it('keeps the prior refresh_token when a refresh omits one', async () => {
    const provider = new FileOAuthProvider('test-server', 18432);
    await provider.saveTokens(initial);

    // A refresh response that returns a new access token but no refresh_token.
    await provider.saveTokens({
      access_token: 'access-2',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const tokens = await provider.tokens();
    expect(tokens?.access_token).toBe('access-2');
    expect(tokens?.refresh_token).toBe('refresh-1');
  });

  it('preserves the persisted refresh_token across provider instances', async () => {
    const first = new FileOAuthProvider('test-server', 18432);
    await first.saveTokens(initial);

    // Fresh instance (simulates a gateway restart) refreshing with no refresh_token.
    const second = new FileOAuthProvider('test-server', 18432);
    await second.tokens(); // loads persisted data from disk
    await second.saveTokens({
      access_token: 'access-3',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const tokens = await new FileOAuthProvider('test-server', 18432).tokens();
    expect(tokens?.access_token).toBe('access-3');
    expect(tokens?.refresh_token).toBe('refresh-1');
  });

  it('replaces the refresh_token when the provider rotates it', async () => {
    const provider = new FileOAuthProvider('test-server', 18432);
    await provider.saveTokens(initial);

    await provider.saveTokens({
      access_token: 'access-2',
      token_type: 'Bearer',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    });

    const tokens = await provider.tokens();
    expect(tokens?.refresh_token).toBe('refresh-2');
  });

  it('keeps a rotated token in memory when persistence fails instead of refreshing it again', async () => {
    const provider = new FileOAuthProvider('broken\0path', 18432);
    await expect(provider.saveTokens(initial)).resolves.toBeUndefined();

    expect((await provider.tokens())?.refresh_token).toBe('refresh-1');
  });

  it('does not truncate the last known-good token file when a replacement write fails', async () => {
    const provider = new FileOAuthProvider('test-server', 18432);
    await provider.saveTokens(initial);
    const path = join(tempHome, '.airlock', 'oauth', 'test-server.json');
    const original = await readFile(path, 'utf-8');
    const protectedParent = join(tempHome, '.airlock');

    await chmod(protectedParent, 0o000);
    try {
      await provider.saveTokens({
        access_token: 'access-2',
        token_type: 'Bearer',
        refresh_token: 'refresh-2',
        expires_in: 3600,
      });
      expect((await provider.tokens())?.refresh_token).toBe('refresh-2');
    } finally {
      await chmod(protectedParent, 0o700);
    }
    expect(await readFile(path, 'utf-8')).toBe(original);
  });
});

describe('FileOAuthProvider — proactive refresh schedule (msUntilRefresh)', () => {
  const BUFFER = 5 * 60 * 1000;
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'airlock-oauth-sched-'));
    process.env.HOME = tempHome;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it('schedules a refresh ~buffer before expiry, measured from when tokens were obtained', async () => {
    const provider = new FileOAuthProvider('sched', 18432);
    await provider.saveTokens({
      access_token: 'a',
      token_type: 'Bearer',
      refresh_token: 'r',
      expires_in: 3600,
    });

    const ms = await provider.msUntilRefresh(BUFFER);
    // obtainedAt was just stamped, so ~ expires_in*1000 - buffer, minus a few ms of test overhead.
    expect(ms).toBeLessThanOrEqual(3600 * 1000 - BUFFER);
    expect(ms).toBeGreaterThan(3600 * 1000 - BUFFER - 5000);
  });

  it('returns undefined without a refresh_token (a refresh is impossible)', async () => {
    const provider = new FileOAuthProvider('norefresh', 18432);
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });
    expect(await provider.msUntilRefresh(BUFFER)).toBeUndefined();
  });

  it('returns undefined without expires_in (lifetime unknown)', async () => {
    const provider = new FileOAuthProvider('noexp', 18432);
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' });
    expect(await provider.msUntilRefresh(BUFFER)).toBeUndefined();
  });

  it('uses a proportional buffer for short-lived tokens instead of refreshing immediately', async () => {
    const provider = new FileOAuthProvider('short', 18432);
    await provider.saveTokens({
      access_token: 'a',
      token_type: 'Bearer',
      refresh_token: 'r',
      expires_in: 300,
    });
    const ms = await provider.msUntilRefresh(BUFFER);
    expect(ms).toBeLessThanOrEqual(270_000);
    expect(ms).toBeGreaterThan(265_000);
  });

  it('never returns negative for an actually expired token', async () => {
    vi.useFakeTimers();
    const provider = new FileOAuthProvider('expired', 18432);
    await provider.saveTokens({
      access_token: 'a',
      token_type: 'Bearer',
      refresh_token: 'r',
      expires_in: 10,
    });
    vi.setSystemTime(Date.now() + 11_000);
    expect(await provider.msUntilRefresh(BUFFER)).toBe(0);
    vi.useRealTimers();
  });

  it('refreshes promptly for a legacy token persisted without obtainedAt', async () => {
    const dir = join(tempHome, '.airlock', 'oauth');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'legacy.json'),
      JSON.stringify({
        tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expires_in: 3600 },
      })
    );
    const provider = new FileOAuthProvider('legacy', 18432);
    expect(await provider.msUntilRefresh(BUFFER)).toBe(0);
  });
});
