import { describe, it, expect } from 'vitest';
import { resolveAgentPermissions, resolveProfiles, applyProfiles } from '../src/config/profiles.js';
import { GatewayConfig } from '../src/config/schema.js';
import type { AgentConfig, ProfileConfig } from '../src/config/schema.js';

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: [],
    allow: [],
    ask: [],
    deny: [],
    tool_overrides: {},
    exec: { allow: [], ask: [], deny: [], env: {}, default_timeout_ms: 30000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 30000 },
    ...overrides,
  };
}

describe('resolveAgentPermissions()', () => {
  it('returns agent permissions when no profiles', () => {
    const agent = makeAgentConfig({ allow: ['github/*'], ask: ['github/create_pr'] });
    const result = resolveAgentPermissions(agent, {});
    expect(result.allow).toEqual(['github/*']);
    expect(result.ask).toEqual(['github/create_pr']);
  });

  it('merges a single profile', () => {
    const agent = makeAgentConfig({
      extends: ['readonly'],
      allow: ['exec/run'],
    });
    const profiles = {
      readonly: { extends: [], allow: ['github/list*', 'github/get*'], ask: [], deny: [] },
    };
    const result = resolveAgentPermissions(agent, profiles);
    expect(result.allow).toContain('github/list*');
    expect(result.allow).toContain('github/get*');
    expect(result.allow).toContain('exec/run');
  });

  it('merges multiple profiles in order', () => {
    const agent = makeAgentConfig({
      extends: ['readonly', 'writer'],
      allow: [],
    });
    const profiles = {
      readonly: { extends: [], allow: ['github/list*'], ask: [], deny: [] },
      writer: { extends: [], allow: ['github/create_pr'], ask: ['github/create_pr'], deny: [] },
    };
    const result = resolveAgentPermissions(agent, profiles);
    expect(result.allow).toEqual(['github/list*', 'github/create_pr']);
    expect(result.ask).toEqual(['github/create_pr']);
  });

  it('deduplicates permissions', () => {
    const agent = makeAgentConfig({
      extends: ['profile1'],
      allow: ['github/*'],
    });
    const profiles = {
      profile1: { extends: [], allow: ['github/*'], ask: [], deny: [] },
    };
    const result = resolveAgentPermissions(agent, profiles);
    expect(result.allow).toEqual(['github/*']);
  });

  it('merges profile deny rules', () => {
    const agent = makeAgentConfig({
      extends: ['dangerous'],
      allow: ['github/*'],
      deny: ['exec/run'],
    });
    const profiles = {
      dangerous: { extends: [], allow: [], ask: [], deny: ['github/delete_repo'] },
    };
    const result = resolveAgentPermissions(agent, profiles);
    expect(result.deny).toEqual(['github/delete_repo', 'exec/run']);
  });
});

describe('resolveProfiles()', () => {
  it('recursively resolves profile inheritance', () => {
    const profiles: Record<string, ProfileConfig> = {
      githubRead: { extends: [], allow: ['github/list*'], ask: [], deny: [] },
      linearRead: { extends: [], allow: ['linear/list*'], ask: [], deny: [] },
      devRo: { extends: ['githubRead', 'linearRead'], allow: ['sentry/list*'], ask: [], deny: [] },
    };

    const resolved = resolveProfiles(profiles);

    expect(resolved.devRo.extends).toEqual([]);
    expect(resolved.devRo.allow).toEqual(['github/list*', 'linear/list*', 'sentry/list*']);
  });

  it('deduplicates diamond inheritance', () => {
    const profiles: Record<string, ProfileConfig> = {
      base: { extends: [], allow: ['github/list*'], ask: [], deny: [] },
      left: { extends: ['base'], allow: ['linear/list*'], ask: [], deny: [] },
      right: { extends: ['base'], allow: ['sentry/list*'], ask: [], deny: [] },
      top: { extends: ['left', 'right'], allow: [], ask: [], deny: [] },
    };

    const resolved = resolveProfiles(profiles);

    expect(resolved.top.allow).toEqual(['github/list*', 'linear/list*', 'sentry/list*']);
  });

  it('keeps inherited grants and local downgrades for eval precedence', () => {
    const profiles: Record<string, ProfileConfig> = {
      base: { extends: [], allow: ['github/*'], ask: [], deny: [] },
      product: {
        extends: ['base'],
        allow: [],
        ask: ['github/merge_pull_request'],
        deny: [],
      },
    };

    const resolved = resolveProfiles(profiles);

    expect(resolved.product.allow).toEqual(['github/*']);
    expect(resolved.product.ask).toEqual(['github/merge_pull_request']);
  });

  it('throws on unknown profile references', () => {
    const profiles: Record<string, ProfileConfig> = {
      product: { extends: ['missing'], allow: [], ask: [], deny: [] },
    };

    expect(() => resolveProfiles(profiles)).toThrow(
      'Profile "product" extends unknown profile "missing"'
    );
  });

  it('throws on profile cycles with the path', () => {
    const profiles: Record<string, ProfileConfig> = {
      paWork: { extends: ['product'], allow: [], ask: [], deny: [] },
      product: { extends: ['paWork'], allow: [], ask: [], deny: [] },
    };

    expect(() => resolveProfiles(profiles)).toThrow(
      'Profile extends cycle detected: paWork -> product -> paWork'
    );
  });
});

describe('applyProfiles()', () => {
  it('mutates agent allow/ask/deny with resolved values', () => {
    const config = GatewayConfig.parse({
      profiles: {
        readonly: { allow: ['github/list*', 'github/get*'] },
        writer: {
          allow: ['github/create_pr'],
          ask: ['github/create_pr'],
          deny: ['github/delete_repo'],
        },
      },
      agents: {
        helena: {
          extends: ['readonly', 'writer'],
          allow: ['exec/run'],
          deny: ['exec/sudo'],
        },
      },
    });

    applyProfiles(config);

    expect(config.agents['helena'].allow).toContain('github/list*');
    expect(config.agents['helena'].allow).toContain('github/get*');
    expect(config.agents['helena'].allow).toContain('github/create_pr');
    expect(config.agents['helena'].allow).toContain('exec/run');
    expect(config.agents['helena'].ask).toContain('github/create_pr');
    expect(config.agents['helena'].deny).toContain('github/delete_repo');
    expect(config.agents['helena'].deny).toContain('exec/sudo');
  });

  it('clears extends after resolution', () => {
    const config = GatewayConfig.parse({
      profiles: { readonly: { allow: ['github/list*'] } },
      agents: { agent1: { extends: ['readonly'] } },
    });

    applyProfiles(config);
    expect(config.agents['agent1'].extends).toEqual([]);
    expect(config.agents['agent1'].allow).toContain('github/list*');
  });

  it('throws on unknown agent profile refs', () => {
    const config = GatewayConfig.parse({
      profiles: {},
      agents: { agent1: { extends: ['nonexistent'], allow: ['exec/run'] } },
    });

    expect(() => applyProfiles(config)).toThrow('Agent extends unknown profile "nonexistent"');
  });

  it('leaves agents without extends unchanged', () => {
    const config = GatewayConfig.parse({
      profiles: { readonly: { allow: ['github/*'] } },
      agents: { agent1: { allow: ['exec/run'] } },
    });

    applyProfiles(config);
    expect(config.agents['agent1'].allow).toEqual(['exec/run']);
  });
});
