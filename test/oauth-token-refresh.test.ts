import { mkdtemp, rm } from 'fs/promises';
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
});
