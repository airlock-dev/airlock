import { describe, it, expect } from 'vitest';
import { resolveAgentPermissions, validateProfiles, applyProfiles } from '../src/config/profiles.js';
import { GatewayConfig } from '../src/config/schema.js';
import type { AgentConfig } from '../src/config/schema.js';

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
      readonly: { allow: ['github/list*', 'github/get*'], ask: [] },
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
      readonly: { allow: ['github/list*'], ask: [] },
      writer: { allow: ['github/create_pr'], ask: ['github/create_pr'] },
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
      profile1: { allow: ['github/*'], ask: [] },
    };
    const result = resolveAgentPermissions(agent, profiles);
    expect(result.allow).toEqual(['github/*']);
  });
});

describe('validateProfiles()', () => {
  it('passes with valid profile references', () => {
    const config = GatewayConfig.parse({
      profiles: { readonly: { allow: ['github/list*'] } },
      agents: { agent1: { extends: ['readonly'] } },
    });
    expect(() => validateProfiles(config)).not.toThrow();
  });

  it('throws on unknown profile reference', () => {
    const config = GatewayConfig.parse({
      profiles: {},
      agents: { agent1: { extends: ['nonexistent'] } },
    });
    expect(() => validateProfiles(config)).toThrow(/unknown profile "nonexistent"/);
  });

  it('passes when no agents use extends', () => {
    const config = GatewayConfig.parse({
      profiles: { readonly: { allow: ['github/*'] } },
      agents: { agent1: { allow: ['github/*'] } },
    });
    expect(() => validateProfiles(config)).not.toThrow();
  });
});

describe('applyProfiles()', () => {
  it('mutates agent allow/ask with resolved values', () => {
    const config = GatewayConfig.parse({
      profiles: {
        readonly: { allow: ['github/list*', 'github/get*'] },
        writer: { allow: ['github/create_pr'], ask: ['github/create_pr'] },
      },
      agents: {
        helena: {
          extends: ['readonly', 'writer'],
          allow: ['exec/run'],
        },
      },
    });

    applyProfiles(config);

    expect(config.agents['helena'].allow).toContain('github/list*');
    expect(config.agents['helena'].allow).toContain('github/get*');
    expect(config.agents['helena'].allow).toContain('github/create_pr');
    expect(config.agents['helena'].allow).toContain('exec/run');
    expect(config.agents['helena'].ask).toContain('github/create_pr');
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
