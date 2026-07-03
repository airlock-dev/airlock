import { describe, it, expect } from 'vitest';
import { assignOAuthCallbackPorts, type Config } from '../src/config/loader.js';

// Minimal provider/config shapes — assignOAuthCallbackPorts only reads
// type/oauth/oauth_callback_port, so we cast a partial to Config.
function makeConfig(providers: Record<string, unknown>): Config {
  return { providers } as unknown as Config;
}

const oauthProvider = () => ({ type: 'http', url: 'https://example.test/mcp', oauth: true });

describe('assignOAuthCallbackPorts', () => {
  it('assigns distinct in-range ports to oauth providers without an explicit one', () => {
    const config = makeConfig({
      linear: oauthProvider(),
      slack: oauthProvider(),
    });
    assignOAuthCallbackPorts(config);

    const providers = config.providers as Record<string, { oauth_callback_port?: number }>;
    const a = providers.linear.oauth_callback_port!;
    const b = providers.slack.oauth_callback_port!;
    expect(a).toBeGreaterThanOrEqual(18432);
    expect(a).toBeLessThan(18432 + 1024);
    expect(b).toBeGreaterThanOrEqual(18432);
    expect(a).not.toBe(b);
  });

  it('is deterministic and independent of the rest of the provider set', () => {
    const first = makeConfig({ linear: oauthProvider(), slack: oauthProvider() });
    assignOAuthCallbackPorts(first);
    // Same id in a different provider set → same port (id-derived, not positional).
    const second = makeConfig({ linear: oauthProvider(), apify: oauthProvider(), sentry: oauthProvider() });
    assignOAuthCallbackPorts(second);

    const p1 = (first.providers as Record<string, { oauth_callback_port?: number }>).linear
      .oauth_callback_port;
    const p2 = (second.providers as Record<string, { oauth_callback_port?: number }>).linear
      .oauth_callback_port;
    expect(p1).toBe(p2);
  });

  it('preserves explicit ports and never reuses them for auto-assigned providers', () => {
    const config = makeConfig({
      p1: oauthProvider(),
      p2: oauthProvider(),
      p3: oauthProvider(),
      pinned: { ...oauthProvider(), oauth_callback_port: 18500 },
    });
    assignOAuthCallbackPorts(config);

    const providers = config.providers as Record<string, { oauth_callback_port?: number }>;
    expect(providers.pinned.oauth_callback_port).toBe(18500);
    const ports = ['p1', 'p2', 'p3', 'pinned'].map((k) => providers[k].oauth_callback_port);
    expect(new Set(ports).size).toBe(4); // all unique, incl. the pinned one
  });

  it('leaves non-oauth providers untouched', () => {
    const config = makeConfig({
      off: { type: 'http', url: 'https://example.test/mcp', oauth: false },
      stdio: { type: 'stdio', command: 'x' },
    });
    assignOAuthCallbackPorts(config);

    const providers = config.providers as Record<string, { oauth_callback_port?: number }>;
    expect(providers.off.oauth_callback_port).toBeUndefined();
    expect(providers.stdio.oauth_callback_port).toBeUndefined();
  });
});
