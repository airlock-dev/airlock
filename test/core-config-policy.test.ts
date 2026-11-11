import { describe, it, expect } from 'vitest';
import { GatewayConfig } from '../src/config/schema.js';
import { validateConfig } from '../src/config/loader.js';
import { applyProfiles } from '../src/config/profiles.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { resolveSandboxConfig } from '../src/sandbox/index.js';

function parse(input: unknown) {
  return GatewayConfig.parse(input);
}

describe('sandbox presets and overrides only change the fields they set', () => {
  it('a preset that only adds deny rules keeps the agent allow_write and allowed_domains', () => {
    const config = parse({
      sandbox_presets: {
        nossh: { filesystem: { deny_read: ['~/.ssh'] }, network: { denied_domains: ['evil.com'] } },
      },
      agents: {
        a: {
          sandbox: {
            enabled: true,
            presets: ['nossh'],
            filesystem: { allow_write: ['/work'] },
            network: { allowed_domains: ['github.com'] },
          },
        },
      },
    });

    const sandbox = config.agents.a.sandbox;
    expect(sandbox.filesystem.allow_write).toEqual(['/work']);
    expect(sandbox.filesystem.deny_read).toEqual(['~/.ssh']);
    expect(sandbox.network.allowed_domains).toEqual(['github.com']);
    expect(sandbox.network.denied_domains).toEqual(['evil.com']);
  });

  it('a sandbox.overrides entry that only adds denied_domains keeps allowed_domains', () => {
    const config = parse({
      agents: {
        a: {
          sandbox: {
            enabled: true,
            network: { allowed_domains: ['github.com'] },
            overrides: { 'fs/*': { network: { denied_domains: ['x.com'] } } },
          },
        },
      },
    });

    const resolved = resolveSandboxConfig(config.agents.a.sandbox, 'fs/read');
    expect(resolved.network.allowed_domains).toEqual(['github.com']);
    expect(resolved.network.denied_domains).toEqual(['x.com']);
    expect(resolved.filesystem.allow_write).toEqual(['.', '/tmp']);
  });

  it("a tool override's explicit sandbox does not reset a preset's allow_write", () => {
    const config = parse({
      sandbox_presets: { ro: { filesystem: { allow_write: [] } } },
      agents: {
        a: {
          tool_overrides: {
            'fs/write': { sandbox_presets: ['ro'], sandbox: { filesystem: { deny_read: ['/x'] } } },
          },
        },
      },
    });

    expect(config.agents.a.tool_overrides['fs/write'].sandbox).toEqual({
      filesystem: { allow_write: [], deny_read: ['/x'] },
    });
  });
});

describe('sandbox presets on profile tool_overrides', () => {
  it('are applied to agents that extend the profile', () => {
    const config = parse({
      providers: { fs: { type: 'stdio', command: 'x' } },
      sandbox_presets: { ro: { filesystem: { allow_write: [] } } },
      profiles: {
        p: { allow: ['fs/*'], tool_overrides: { 'fs/write': { sandbox_presets: ['ro'] } } },
      },
      agents: { a: { extends: ['p'], sandbox: { enabled: true } } },
    });
    applyProfiles(config);

    const override = config.agents.a.tool_overrides['fs/write'];
    expect(override.sandbox).toEqual({ filesystem: { allow_write: [] } });
    expect(override).not.toHaveProperty('args');
    expect(
      resolveSandboxConfig(config.agents.a.sandbox, 'fs/write', override.sandbox).filesystem
        .allow_write
    ).toEqual([]);
  });

  it("layer an agent's own override sandbox on top of the profile's", () => {
    const config = parse({
      sandbox_presets: {
        ro: { filesystem: { allow_write: [], deny_read: ['/secrets'] } },
        gh: { network: { allowed_domains: ['api.github.com'] } },
      },
      profiles: {
        p: { tool_overrides: { 'fs/write': { sandbox_presets: ['ro'] } } },
      },
      agents: {
        a: {
          extends: ['p'],
          tool_overrides: { 'fs/write': { sandbox_presets: ['gh'] } },
        },
      },
    });
    applyProfiles(config);

    const override = config.agents.a.tool_overrides['fs/write'];
    expect(override.sandbox_presets).toEqual(['ro', 'gh']);
    expect(override.sandbox).toEqual({
      filesystem: { allow_write: [], deny_read: ['/secrets'] },
      network: { allowed_domains: ['api.github.com'] },
    });
  });
});

describe('allow/ask vs deny diagnostics follow the engine (most specific wins)', () => {
  function diagnosticsFor(agent: Record<string, unknown>) {
    const config = parse({
      providers: { github: { type: 'stdio', command: 'x' } },
      agents: { a: agent },
    });
    return {
      messages: validateConfig(config).map((d) => d.message),
      engine: new AllowlistEngine(config.agents),
    };
  }

  it('does not warn when a narrower allow carves an exception out of a broader deny', () => {
    const { messages, engine } = diagnosticsFor({
      allow: ['github/create_pr'],
      deny: ['github/*'],
    });
    expect(messages.filter((m) => m.includes('deny'))).toEqual([]);
    expect(engine.evaluate('a', 'github/create_pr')).toBe('allow');
  });

  it('does not warn when a narrower deny carves an exception out of a broader allow', () => {
    const { messages, engine } = diagnosticsFor({
      allow: ['github/*'],
      deny: ['github/delete_repo'],
    });
    expect(messages.filter((m) => m.includes('deny'))).toEqual([]);
    expect(engine.evaluate('a', 'github/list_prs')).toBe('allow');
  });

  it('warns when the same pattern is in allow and deny, and never says "deny always wins"', () => {
    const { messages, engine } = diagnosticsFor({
      allow: ['github/*'],
      ask: ['github/merge'],
      deny: ['github/*', 'github/merge'],
    });
    expect(messages).toContain(
      '"github/*" is listed in both allow and deny; the deny entry wins the tie, so the allow entry has no effect.'
    );
    expect(messages).toContain(
      '"github/merge" is listed in both ask and deny; the deny entry wins the tie, so approval will never be requested.'
    );
    expect(messages.some((m) => m.includes('always wins'))).toBe(false);
    expect(engine.evaluate('a', 'github/list_prs')).toBe('deny');
  });
});

describe('implicit airlock approval tools', () => {
  function errorsFor(agent: Record<string, unknown>, providers: Record<string, unknown> = {}) {
    const config = parse({
      providers: { github: { type: 'stdio', command: 'x' }, ...providers },
      agents: { a: agent },
    });
    return validateConfig(config)
      .filter((d) => d.level === 'error')
      .map((d) => d.message);
  }

  it('can be denied without declaring an airlock provider', () => {
    expect(errorsFor({ ask: ['github/*'], deny: ['airlock/request_approval'] })).toEqual([]);
    expect(errorsFor({ ask: ['github/*'], deny: ['airlock/*'] })).toEqual([]);
  });

  it('still rejects airlock tools that only exist when the airlock provider is declared', () => {
    expect(errorsFor({ allow: ['airlock/ask_user'] })).toEqual([
      'Pattern references unknown provider "airlock".',
    ]);
    expect(errorsFor({ allow: ['airlock/ask_user'] }, { airlock: 'builtin' })).toEqual([]);
  });
});

describe('middleware mode/backend values', () => {
  function middlewareResult(item: Record<string, unknown>) {
    return GatewayConfig.safeParse({ agents: { a: { middleware: [item] } } });
  }

  it.each([
    { name: 'output-injection-detector', mode: 'escalate' },
    { name: 'canary-token-injector', mode: 'mangle' },
    { name: 'sensitivity-classifier', mode: 'mangle' },
    { name: 'injection-detector', backend: 'heuristic' },
    { name: 'sensitivity-classifier', backend: 'deberta' },
  ])('rejects $name with an unsupported option %#', (item) => {
    const result = middlewareResult(item);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/does not support/);
  });

  it.each([
    { name: 'output-injection-detector', mode: 'mangle' },
    { name: 'canary-token-injector', mode: 'detect' },
    { name: 'injection-detector', backend: 'deberta', mode: 'escalate' },
    { name: 'sensitivity-classifier', backend: 'llm', mode: 'escalate' },
  ])('accepts $name with a supported option %#', (item) => {
    expect(middlewareResult(item).success).toBe(true);
  });

  it('treats an escalating canary-token-injector (its default) as able to need approval', () => {
    const config = parse({
      agents: {
        canary: { middleware: [{ name: 'canary-token-injector' }] },
        disabled: {
          middleware: [{ name: 'injection-detector', mode: 'escalate', enabled: false }],
        },
      },
    });
    const engine = new AllowlistEngine(config.agents);
    expect(engine.evaluate('canary', 'airlock/request_approval')).toBe('allow');
    expect(engine.evaluate('disabled', 'airlock/request_approval')).toBe('deny');
  });
});
