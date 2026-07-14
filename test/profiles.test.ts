import { describe, it, expect } from 'vitest';
import {
  resolveAgentPermissions,
  resolveProfiles,
  applyProfiles,
  explainAgentPermissions,
} from '../src/config/profiles.js';
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

  it('desugars inherited arg scope into concrete argument policies', () => {
    const config = GatewayConfig.parse({
      value_sets: {
        airlock_repos: ['airlock-dev/airlock'],
        safe_fix_branches: ['fix/*', 'feat/*'],
      },
      arg_dimensions: {
        github_repo: {
          match: 'in',
          bindings: {
            'github/push_files': 'repo',
            'github/create_pull_request': 'repo',
          },
        },
        github_branch: {
          match: 'glob_in',
          bindings: {
            'github/push_files': 'branch',
            'github/create_pull_request': 'head',
          },
        },
      },
      profiles: {
        airlock_repo: {
          arg_scope: { github_repo: 'airlock_repos' },
        },
        fix_branches: {
          arg_scope: { github_branch: 'safe_fix_branches' },
        },
      },
      agents: {
        autofix: {
          extends: ['airlock_repo', 'fix_branches'],
          allow: ['github/push_files', 'github/create_pull_request'],
        },
      },
    });

    applyProfiles(config);

    expect(config.agents['autofix'].arg_policy).toEqual({
      'github/push_files': {
        repo: [
          {
            allow: ['airlock-dev/airlock'],
            label: 'airlock_repos',
            value_set: 'airlock_repos',
            expose_values: true,
            path: 'repo',
          },
        ],
        branch: [
          {
            glob_allow: ['fix/*', 'feat/*'],
            label: 'safe_fix_branches',
            value_set: 'safe_fix_branches',
            expose_values: true,
            path: 'branch',
          },
        ],
      },
      'github/create_pull_request': {
        repo: [
          {
            allow: ['airlock-dev/airlock'],
            label: 'airlock_repos',
            value_set: 'airlock_repos',
            expose_values: true,
            path: 'repo',
          },
        ],
        head: [
          {
            glob_allow: ['fix/*', 'feat/*'],
            label: 'safe_fix_branches',
            value_set: 'safe_fix_branches',
            expose_values: true,
            path: 'head',
          },
        ],
      },
    });
  });

  it('unions multiple value sets for the same inherited dimension', () => {
    const config = GatewayConfig.parse({
      value_sets: {
        airlock_repos: ['airlock-dev/airlock'],
        docs_repos: ['airlock-dev/docs'],
      },
      arg_dimensions: {
        github_repo: {
          match: 'in',
          bindings: {
            'github/push_files': 'repo',
          },
        },
      },
      profiles: {
        airlock_repo: {
          arg_scope: { github_repo: 'airlock_repos' },
        },
        docs_repo: {
          arg_scope: { github_repo: 'docs_repos' },
        },
      },
      agents: {
        autofix: {
          extends: ['airlock_repo', 'docs_repo'],
          allow: ['github/push_files'],
        },
      },
    });

    applyProfiles(config);

    expect(config.agents['autofix'].arg_policy?.['github/push_files']?.repo).toEqual([
      {
        allow: ['airlock-dev/airlock', 'airlock-dev/docs'],
        label: 'airlock_repos + docs_repos',
        value_set: 'airlock_repos + docs_repos',
        expose_values: true,
        path: 'repo',
      },
    ]);
  });

  it('resolves named value sets in explicit arg policy', () => {
    const config = GatewayConfig.parse({
      value_sets: {
        sandbox_calendars: ['work-calendar'],
      },
      agents: {
        calendar: {
          allow: ['gws/manage_event'],
          arg_policy: {
            'gws/manage_event': {
              calendar_id: { in: 'sandbox_calendars' },
            },
          },
        },
      },
    });

    applyProfiles(config);

    expect(config.agents['calendar'].arg_policy?.['gws/manage_event']?.calendar_id).toEqual([
      {
        allow: ['work-calendar'],
        label: 'sandbox_calendars',
        value_set: 'sandbox_calendars',
        expose_values: true,
      },
    ]);
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

describe('explainAgentPermissions()', () => {
  it('shows permission provenance, precedence inputs, and arg_scope bindings', () => {
    const config = GatewayConfig.parse({
      value_sets: {
        airlock_repos: ['airlock-dev/airlock'],
      },
      arg_dimensions: {
        github_repo: {
          match: 'in',
          bindings: {
            'github/push_files': 'repo',
          },
        },
      },
      profiles: {
        readonly: {
          allow: ['github/*'],
          arg_scope: { github_repo: 'airlock_repos' },
        },
        guarded: {
          extends: ['readonly'],
          deny: ['github/delete_repo'],
        },
      },
      agents: {
        dev: {
          extends: ['guarded'],
          ask: ['github/push_files'],
        },
      },
    });

    const explanation = explainAgentPermissions(config, 'dev');

    expect(explanation.permissions.allow).toContainEqual({
      pattern: 'github/*',
      sources: [{ kind: 'profile', source: 'profile:readonly' }],
    });
    expect(explanation.permissions.ask).toContainEqual({
      pattern: 'github/push_files',
      sources: [{ kind: 'agent', source: 'agent:dev' }],
    });
    expect(explanation.permissions.deny).toContainEqual({
      pattern: 'github/delete_repo',
      sources: [{ kind: 'profile', source: 'profile:guarded' }],
    });
    expect(explanation.extendsTree[0]).toMatchObject({
      name: 'dev',
      extends: [{ name: 'guarded', extends: [{ name: 'readonly' }] }],
    });
    expect(explanation.argScope[0]).toMatchObject({
      dimension: 'github_repo',
      valueSets: [
        {
          name: 'airlock_repos',
          values: ['airlock-dev/airlock'],
          sources: [{ kind: 'profile', source: 'profile:readonly' }],
        },
      ],
      bindings: [
        {
          tool: 'github/push_files',
          arg: 'repo',
        },
      ],
    });
  });
});

describe('default_profile', () => {
  it('is inherited by every agent at lowest precedence', () => {
    const config = GatewayConfig.parse({
      default_profile: 'base',
      profiles: {
        base: { allow: ['airlock/status', 'airlock/list_provider_tools'] },
        readonly: { allow: ['github/get*'] },
      },
      agents: {
        helena: { extends: ['readonly'], allow: ['exec/run'] },
        selene: {},
      },
    });

    applyProfiles(config);

    // Agent with its own extends still gets the default, plus its own grants.
    expect(config.agents['helena'].allow).toEqual(
      expect.arrayContaining(['airlock/status', 'airlock/list_provider_tools', 'github/get*', 'exec/run'])
    );
    // Agent with no extends of its own still inherits the default.
    expect(config.agents['selene'].allow).toEqual(
      expect.arrayContaining(['airlock/status', 'airlock/list_provider_tools'])
    );
  });

  it('can be overridden by an agent deny (deny wins at evaluation)', () => {
    const config = GatewayConfig.parse({
      default_profile: 'base',
      profiles: { base: { allow: ['airlock/status'] } },
      agents: { locked: { deny: ['airlock/status'] } },
    });

    applyProfiles(config);

    // Resolution unions both lists; the deny is what takes effect (precedence deny > allow),
    // so an agent can always claw back a tool the default profile grants.
    expect(config.agents['locked'].deny).toContain('airlock/status');
  });

  it('is skipped for an agent that opts out with inherit_default: false', () => {
    const config = GatewayConfig.parse({
      default_profile: 'base',
      profiles: { base: { allow: ['airlock/status'] } },
      agents: {
        joined: {},
        isolated: { inherit_default: false },
      },
    });

    applyProfiles(config);

    expect(config.agents['joined'].allow).toContain('airlock/status');
    expect(config.agents['isolated'].allow).not.toContain('airlock/status');
  });

  it('is not duplicated when an agent already extends it explicitly', () => {
    const config = GatewayConfig.parse({
      default_profile: 'base',
      profiles: { base: { allow: ['airlock/status'] } },
      agents: { dev: { extends: ['base'] } },
    });

    // The transform must not double-inject the default into extends.
    expect(config.agents['dev'].extends).toEqual(['base']);

    applyProfiles(config);
    expect(config.agents['dev'].allow).toContain('airlock/status');
  });
});
