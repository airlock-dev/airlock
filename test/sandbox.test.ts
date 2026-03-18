import { describe, it, expect, vi } from 'vitest';
import {
  SandboxConfig,
  SandboxFilesystemConfig,
  SandboxNetworkConfig,
  SandboxOverrideConfig,
  AgentConfig,
  ToolOverride,
  GatewayConfig,
} from '../src/config/schema.js';
import {
  resolveSandboxConfig,
  toSandboxRuntimeConfig,
  wrapCommandWithSandbox,
} from '../src/sandbox/index.js';
import type { ResolvedSandboxConfig } from '../src/sandbox/index.js';

// ─── Schema parsing ─────────────────────────────────────────────────────────

describe('SandboxConfig schema', () => {
  it('parses full config with all fields', () => {
    const result = SandboxConfig.safeParse({
      enabled: true,
      filesystem: {
        allow_write: ['/project'],
        deny_read: ['/etc/secrets'],
        deny_write: ['/usr'],
        allow_read: ['/project', '/tmp'],
      },
      network: {
        allowed_domains: ['api.example.com'],
        denied_domains: ['evil.com'],
      },
      overrides: {
        'github/*': {
          filesystem: { deny_read: ['/extra'] },
          network: { allowed_domains: ['github.com'] },
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.enabled).toBe(true);
    expect(result.data.filesystem.allow_write).toEqual(['/project']);
    expect(result.data.network.denied_domains).toEqual(['evil.com']);
    expect(result.data.overrides['github/*']).toBeDefined();
  });

  it('applies defaults for empty config', () => {
    const result = SandboxConfig.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.enabled).toBe(false);
    expect(result.data.filesystem.allow_write).toEqual(['.', '/tmp']);
    expect(result.data.filesystem.deny_read).toEqual([]);
    expect(result.data.filesystem.deny_write).toEqual([]);
    expect(result.data.filesystem.allow_read).toBeUndefined();
    expect(result.data.network.allowed_domains).toEqual([]);
    expect(result.data.network.denied_domains).toEqual([]);
    expect(result.data.overrides).toEqual({});
  });

  it('rejects invalid types', () => {
    const result = SandboxConfig.safeParse({
      enabled: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects allow_write as non-array', () => {
    const result = SandboxConfig.safeParse({
      filesystem: { allow_write: 'not-array' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects deny_read as non-array', () => {
    const result = SandboxConfig.safeParse({
      filesystem: { deny_read: 123 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects denied_domains as non-array', () => {
    const result = SandboxConfig.safeParse({
      network: { denied_domains: 'evil.com' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects enabled as number', () => {
    const result = SandboxConfig.safeParse({ enabled: 1 });
    expect(result.success).toBe(false);
  });

  it('parses filesystem config defaults', () => {
    const result = SandboxFilesystemConfig.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allow_write).toEqual(['.', '/tmp']);
    expect(result.data.deny_read).toEqual([]);
    expect(result.data.deny_write).toEqual([]);
  });

  it('parses network config defaults', () => {
    const result = SandboxNetworkConfig.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed_domains).toEqual([]);
    expect(result.data.denied_domains).toEqual([]);
  });

  it('parses override config with partial fields', () => {
    const result = SandboxOverrideConfig.safeParse({
      filesystem: { deny_read: ['/secret'] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.filesystem?.deny_read).toEqual(['/secret']);
    expect(result.data.network).toBeUndefined();
  });

  it('parses override config with only network', () => {
    const result = SandboxOverrideConfig.safeParse({
      network: { denied_domains: ['bad.com'] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.filesystem).toBeUndefined();
    expect(result.data.network?.denied_domains).toEqual(['bad.com']);
  });

  it('parses overrides map with glob patterns as keys', () => {
    const result = SandboxConfig.safeParse({
      enabled: true,
      overrides: {
        'exec/*': { filesystem: { deny_write: ['/sys'] } },
        'github/create_pr': { network: { denied_domains: ['evil.com'] } },
        'code*': { filesystem: { allow_write: ['/sandbox'] } },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data.overrides)).toHaveLength(3);
  });

  it('parses SandboxConfig with enabled: true and minimal filesystem', () => {
    const result = SandboxConfig.safeParse({
      enabled: true,
      filesystem: { allow_write: ['/home'] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.enabled).toBe(true);
    expect(result.data.filesystem.allow_write).toEqual(['/home']);
    expect(result.data.filesystem.deny_read).toEqual([]);
  });

  it('allows empty overrides object in SandboxOverrideConfig', () => {
    const result = SandboxOverrideConfig.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ─── AgentConfig sandbox defaults ────────────────────────────────────────────

describe('AgentConfig sandbox defaults', () => {
  it('defaults sandbox to disabled when omitted', () => {
    const parsed = GatewayConfig.parse({ agents: { a1: {} } });
    const agent = parsed.agents['a1'];
    expect(agent.sandbox.enabled).toBe(false);
    expect(agent.sandbox.filesystem.allow_write).toEqual(['.', '/tmp']);
    expect(agent.sandbox.overrides).toEqual({});
  });

  it('sandbox config is present with default values even if not specified', () => {
    const parsed = GatewayConfig.parse({ agents: { a1: {} } });
    const agent = parsed.agents['a1'];
    expect(agent.sandbox).toBeDefined();
    expect(agent.sandbox.filesystem).toBeDefined();
    expect(agent.sandbox.network).toBeDefined();
    expect(agent.sandbox.overrides).toBeDefined();
  });

  it('respects explicit enabled: true at agent level', () => {
    const parsed = GatewayConfig.parse({
      agents: {
        a1: {
          sandbox: { enabled: true },
        },
      },
    });
    expect(parsed.agents['a1'].sandbox.enabled).toBe(true);
  });

  it('respects explicit enabled: false at agent level', () => {
    const parsed = GatewayConfig.parse({
      agents: {
        a1: {
          sandbox: { enabled: false },
        },
      },
    });
    expect(parsed.agents['a1'].sandbox.enabled).toBe(false);
  });
});

describe('sandbox presets', () => {
  it('applies agent-level sandbox presets from GatewayConfig', () => {
    const parsed = GatewayConfig.parse({
      sandbox_presets: {
        local_transform: {
          filesystem: {
            allow_write: ['/tmp'],
            deny_read: ['~/.ssh'],
            deny_write: ['.'],
            allow_read: ['.'],
          },
          network: {
            allowed_domains: [],
            denied_domains: [],
          },
        },
      },
      agents: {
        a1: {
          sandbox: {
            enabled: true,
            presets: ['local_transform'],
          },
        },
      },
    });

    expect(parsed.agents['a1'].sandbox.filesystem.allow_write).toEqual(['/tmp']);
    expect(parsed.agents['a1'].sandbox.filesystem.allow_read).toEqual(['.']);
    expect(parsed.agents['a1'].sandbox.filesystem.deny_read).toContain('~/.ssh');
    expect(parsed.agents['a1'].sandbox.filesystem.deny_write).toContain('.');
  });

  it('applies tool override sandbox presets and lets explicit sandbox override them', () => {
    const parsed = GatewayConfig.parse({
      sandbox_presets: {
        local_transform: {
          filesystem: {
            allow_write: ['/tmp'],
            deny_read: ['~/.ssh'],
          },
          network: {
            allowed_domains: [],
            denied_domains: [],
          },
        },
        github_only: {
          network: {
            allowed_domains: ['api.github.com'],
            denied_domains: [],
          },
        },
      },
      agents: {
        a1: {
          tool_overrides: {
            'python/sandboxed': {
              alias_of: 'exec/run',
              sandbox_presets: ['local_transform', 'github_only'],
              sandbox: {
                filesystem: {
                  allow_write: ['/var/tmp'],
                },
              },
            },
          },
        },
      },
    });

    expect(
      parsed.agents['a1'].tool_overrides['python/sandboxed'].sandbox?.filesystem?.allow_write
    ).toEqual(['/var/tmp']);
    expect(
      parsed.agents['a1'].tool_overrides['python/sandboxed'].sandbox?.filesystem?.deny_read
    ).toContain('~/.ssh');
    expect(
      parsed.agents['a1'].tool_overrides['python/sandboxed'].sandbox?.network?.allowed_domains
    ).toEqual(['api.github.com']);
  });
});

// ─── ToolOverride schema ─────────────────────────────────────────────────────

describe('ToolOverride schema', () => {
  it('parses ToolOverride with alias_of and sandbox', () => {
    const result = ToolOverride.safeParse({
      alias_of: 'code/eval',
      description: 'Sandboxed evaluation',
      sandbox: {
        filesystem: { allow_write: ['/sandbox'] },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.alias_of).toBe('code/eval');
    expect(result.data.sandbox?.filesystem?.allow_write).toEqual(['/sandbox']);
  });

  it('parses ToolOverride without alias_of (backward compat)', () => {
    const result = ToolOverride.safeParse({
      description: 'Custom description',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.alias_of).toBeUndefined();
    expect(result.data.sandbox).toBeUndefined();
    expect(result.data.description).toBe('Custom description');
  });

  it('parses empty ToolOverride', () => {
    const result = ToolOverride.safeParse({});
    expect(result.success).toBe(true);
  });

  it('parses ToolOverride with only description', () => {
    const result = ToolOverride.safeParse({ description: 'Override only' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.description).toBe('Override only');
    expect(result.data.alias_of).toBeUndefined();
    expect(result.data.sandbox).toBeUndefined();
  });

  it('parses ToolOverride with sandbox but no alias_of', () => {
    const result = ToolOverride.safeParse({
      sandbox: {
        filesystem: { deny_write: ['/protected'] },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.alias_of).toBeUndefined();
    expect(result.data.sandbox?.filesystem?.deny_write).toEqual(['/protected']);
  });

  it('parses ToolOverride with alias_of, description, and sandbox together', () => {
    const result = ToolOverride.safeParse({
      alias_of: 'exec/run',
      description: 'Restricted exec',
      sandbox: {
        filesystem: { allow_write: ['/tmp'] },
        network: { denied_domains: ['evil.net'] },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.alias_of).toBe('exec/run');
    expect(result.data.description).toBe('Restricted exec');
    expect(result.data.sandbox?.filesystem?.allow_write).toEqual(['/tmp']);
    expect(result.data.sandbox?.network?.denied_domains).toEqual(['evil.net']);
  });
});

// ─── resolveSandboxConfig ────────────────────────────────────────────────────

describe('resolveSandboxConfig()', () => {
  const baseSandbox = SandboxConfig.parse({
    enabled: true,
    filesystem: {
      allow_write: ['.', '/tmp'],
      deny_read: ['/etc/shadow'],
      deny_write: ['/usr'],
    },
    network: {
      allowed_domains: ['api.example.com'],
      denied_domains: ['evil.com'],
    },
  });

  it('returns base config when no overrides match', () => {
    const result = resolveSandboxConfig(baseSandbox, 'unknown/tool');
    expect(result.filesystem.allow_write).toEqual(['.', '/tmp']);
    expect(result.filesystem.deny_read).toEqual(['/etc/shadow']);
    expect(result.network.allowed_domains).toEqual(['api.example.com']);
  });

  it('applies matching override from sandbox.overrides', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'github/*': {
          filesystem: { deny_read: ['/extra-secret'] },
          network: { allowed_domains: ['github.com'] },
        },
      },
    });

    const result = resolveSandboxConfig(withOverrides, 'github/create_pr');
    // deny_read is additive
    expect(result.filesystem.deny_read).toEqual(['/etc/shadow', '/extra-secret']);
    // allowed_domains replaces
    expect(result.network.allowed_domains).toEqual(['github.com']);
    // allow_write unchanged (not in override)
    expect(result.filesystem.allow_write).toEqual(['.', '/tmp']);
  });

  it('applies prefix override (e.g. "exec*" matches "exec/run")', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'exec*': {
          filesystem: { deny_write: ['/etc'] },
        },
      },
    });

    const result = resolveSandboxConfig(withOverrides, 'exec/run');
    expect(result.filesystem.deny_write).toEqual(['/usr', '/etc']);
  });

  it('does not match wrong tool', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'github/*': {
          filesystem: { allow_write: ['/github-only'] },
        },
      },
    });

    const result = resolveSandboxConfig(withOverrides, 'slack/post');
    expect(result.filesystem.allow_write).toEqual(['.', '/tmp']);
  });

  it('applies tool override sandbox with highest priority', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'github/*': {
          filesystem: { allow_write: ['/from-override'] },
        },
      },
    });

    const toolOverrideSandbox = SandboxOverrideConfig.parse({
      filesystem: { allow_write: ['/from-alias'] },
    });

    const result = resolveSandboxConfig(withOverrides, 'github/create_pr', toolOverrideSandbox);
    // Tool override replaces even the sandbox.overrides value
    expect(result.filesystem.allow_write).toEqual(['/from-alias']);
  });

  it('uses most specific override (longer pattern first)', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'github/*': {
          filesystem: { allow_write: ['/short'] },
        },
        'github/create_pr': {
          filesystem: { allow_write: ['/exact'] },
        },
      },
    });

    const result = resolveSandboxConfig(withOverrides, 'github/create_pr');
    expect(result.filesystem.allow_write).toEqual(['/exact']);
  });

  it('mergeOverride: allow_write replaces', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', {
      filesystem: { allow_write: ['/new'], deny_read: [], deny_write: [] },
    });
    expect(result.filesystem.allow_write).toEqual(['/new']);
  });

  it('mergeOverride: deny_read is additive', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', {
      filesystem: { allow_write: ['.', '/tmp'], deny_read: ['/new-secret'], deny_write: [] },
    });
    expect(result.filesystem.deny_read).toEqual(['/etc/shadow', '/new-secret']);
  });

  it('mergeOverride: deny_write is additive', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', {
      filesystem: { allow_write: ['.', '/tmp'], deny_read: [], deny_write: ['/var'] },
    });
    expect(result.filesystem.deny_write).toEqual(['/usr', '/var']);
  });

  it('mergeOverride: denied_domains is additive', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', {
      network: { allowed_domains: [], denied_domains: ['malware.com'] },
    });
    expect(result.network.denied_domains).toEqual(['evil.com', 'malware.com']);
  });

  it('mergeOverride: allowed_domains replaces', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', {
      network: { allowed_domains: ['new.com'], denied_domains: [] },
    });
    expect(result.network.allowed_domains).toEqual(['new.com']);
  });

  it('allow_read is optional and passes through when present in override', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', {
      filesystem: {
        allow_write: ['.'],
        deny_read: [],
        deny_write: [],
        allow_read: ['/project', '/data'],
      },
    });
    expect(result.filesystem.allow_read).toEqual(['/project', '/data']);
  });

  it('empty overrides map returns base unchanged', () => {
    const withEmpty = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {},
    });
    const result = resolveSandboxConfig(withEmpty, 'any/tool');
    expect(result.filesystem.allow_write).toEqual(['.', '/tmp']);
    expect(result.filesystem.deny_read).toEqual(['/etc/shadow']);
    expect(result.network.allowed_domains).toEqual(['api.example.com']);
  });

  it('tool override + pattern override + base all present — correct layering', () => {
    const withOverrides = SandboxConfig.parse({
      enabled: true,
      filesystem: {
        allow_write: ['.', '/tmp'],
        deny_read: ['/base-secret'],
        deny_write: ['/base-deny'],
      },
      network: {
        allowed_domains: ['base.com'],
        denied_domains: ['base-evil.com'],
      },
      overrides: {
        'github/*': {
          filesystem: { deny_read: ['/pattern-secret'] },
          network: { denied_domains: ['pattern-evil.com'] },
        },
      },
    });

    const toolOverrideSandbox = SandboxOverrideConfig.parse({
      filesystem: { deny_read: ['/tool-secret'] },
      network: { denied_domains: ['tool-evil.com'] },
    });

    const result = resolveSandboxConfig(withOverrides, 'github/create_pr', toolOverrideSandbox);

    // deny_read: base + pattern (additive) + tool (additive)
    expect(result.filesystem.deny_read).toEqual([
      '/base-secret',
      '/pattern-secret',
      '/tool-secret',
    ]);

    // denied_domains: base + pattern (additive) + tool (additive)
    expect(result.network.denied_domains).toEqual([
      'base-evil.com',
      'pattern-evil.com',
      'tool-evil.com',
    ]);
  });

  it('non-matching pattern override leaves base unchanged', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'slack/*': {
          filesystem: { allow_write: ['/slack-dir'] },
          network: { allowed_domains: ['slack.com'] },
        },
      },
    });
    const result = resolveSandboxConfig(withOverrides, 'github/create_pr');
    expect(result.filesystem.allow_write).toEqual(['.', '/tmp']);
    expect(result.network.allowed_domains).toEqual(['api.example.com']);
  });

  it('exact match override beats glob match', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'github/*': {
          filesystem: { allow_write: ['/glob-match'] },
        },
        'github/create_pr': {
          filesystem: { allow_write: ['/exact-match'] },
        },
      },
    });
    const result = resolveSandboxConfig(withOverrides, 'github/create_pr');
    expect(result.filesystem.allow_write).toEqual(['/exact-match']);
  });

  it('longer prefix override wins over shorter prefix', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'g*': {
          filesystem: { allow_write: ['/short-prefix'] },
        },
        'github*': {
          filesystem: { allow_write: ['/long-prefix'] },
        },
      },
    });
    const result = resolveSandboxConfig(withOverrides, 'github/create_pr');
    expect(result.filesystem.allow_write).toEqual(['/long-prefix']);
  });

  it('does not mutate the base sandbox config', () => {
    const config = SandboxConfig.parse({
      enabled: true,
      filesystem: {
        allow_write: ['.'],
        deny_read: ['/secret'],
        deny_write: ['/system'],
      },
      network: {
        allowed_domains: ['base.com'],
        denied_domains: ['evil.com'],
      },
    });

    resolveSandboxConfig(config, 'tool', {
      filesystem: { deny_read: ['/new-secret'], deny_write: ['/new-system'] },
      network: { denied_domains: ['new-evil.com'] },
    });

    // Original should be unchanged
    expect(config.filesystem.deny_read).toEqual(['/secret']);
    expect(config.filesystem.deny_write).toEqual(['/system']);
    expect(config.network.denied_domains).toEqual(['evil.com']);
  });

  it('allow_read remains undefined when not set in base or override', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool');
    expect(result.filesystem.allow_read).toBeUndefined();
  });

  it('allow_read from base is preserved when override does not specify it', () => {
    const baseWithAllowRead = SandboxConfig.parse({
      enabled: true,
      filesystem: {
        allow_write: ['.'],
        deny_read: [],
        deny_write: [],
        allow_read: ['/base-read'],
      },
      network: { allowed_domains: [], denied_domains: [] },
    });

    const result = resolveSandboxConfig(baseWithAllowRead, 'tool', {
      filesystem: { deny_read: ['/extra'] },
    });
    expect(result.filesystem.allow_read).toEqual(['/base-read']);
  });

  it('allow_read from override replaces base allow_read', () => {
    const baseWithAllowRead = SandboxConfig.parse({
      enabled: true,
      filesystem: {
        allow_write: ['.'],
        deny_read: [],
        deny_write: [],
        allow_read: ['/base-read'],
      },
      network: { allowed_domains: [], denied_domains: [] },
    });

    const result = resolveSandboxConfig(baseWithAllowRead, 'tool', {
      filesystem: { allow_read: ['/override-read'] },
    });
    expect(result.filesystem.allow_read).toEqual(['/override-read']);
  });

  it('handles override with only network section', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', {
      network: { allowed_domains: ['only-network.com'] },
    });
    // Network replaced
    expect(result.network.allowed_domains).toEqual(['only-network.com']);
    // Filesystem unchanged
    expect(result.filesystem.allow_write).toEqual(['.', '/tmp']);
    expect(result.filesystem.deny_read).toEqual(['/etc/shadow']);
  });

  it('handles override with only filesystem section', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', {
      filesystem: { allow_write: ['/only-fs'] },
    });
    // Filesystem changed
    expect(result.filesystem.allow_write).toEqual(['/only-fs']);
    // Network unchanged
    expect(result.network.allowed_domains).toEqual(['api.example.com']);
    expect(result.network.denied_domains).toEqual(['evil.com']);
  });

  it('undefined toolOverrideSandbox is treated as no override', () => {
    const result = resolveSandboxConfig(baseSandbox, 'tool', undefined);
    expect(result.filesystem.allow_write).toEqual(['.', '/tmp']);
    expect(result.network.allowed_domains).toEqual(['api.example.com']);
  });

  it('multiple pattern overrides — only most specific applies', () => {
    const withOverrides = SandboxConfig.parse({
      ...baseSandbox,
      overrides: {
        'g*': {
          filesystem: { deny_read: ['/from-g'] },
        },
        'github/*': {
          filesystem: { deny_read: ['/from-github'] },
        },
        'github/create*': {
          filesystem: { deny_read: ['/from-github-create'] },
        },
      },
    });
    // 'github/create_pr' matches all three, but 'github/create*' is longest
    const result = resolveSandboxConfig(withOverrides, 'github/create_pr');
    // Only the most specific override's deny_read is merged
    expect(result.filesystem.deny_read).toEqual(['/etc/shadow', '/from-github-create']);
  });
});

// ─── toSandboxRuntimeConfig ──────────────────────────────────────────────────

describe('toSandboxRuntimeConfig()', () => {
  it('converts resolved config to SandboxRuntimeConfig format', () => {
    const resolved: ResolvedSandboxConfig = {
      filesystem: {
        allow_write: ['/project', '/tmp'],
        deny_read: ['/secret'],
        deny_write: ['/usr'],
        allow_read: ['/project'],
      },
      network: {
        allowed_domains: ['api.com'],
        denied_domains: ['evil.com'],
      },
    };

    const result = toSandboxRuntimeConfig(resolved);
    expect(result.filesystem.allowWrite).toEqual(['/project', '/tmp']);
    expect(result.filesystem.denyRead).toEqual(['/secret']);
    expect(result.filesystem.denyWrite).toEqual(['/usr']);
    expect(result.filesystem.allowRead).toEqual(['/project']);
    expect(result.network.allowedDomains).toEqual(['api.com']);
    expect(result.network.deniedDomains).toEqual(['evil.com']);
  });

  it('omits allowRead when not set', () => {
    const resolved: ResolvedSandboxConfig = {
      filesystem: {
        allow_write: ['.'],
        deny_read: [],
        deny_write: [],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    };

    const result = toSandboxRuntimeConfig(resolved);
    expect(result.filesystem.allowRead).toBeUndefined();
  });

  it('handles all empty arrays correctly', () => {
    const resolved: ResolvedSandboxConfig = {
      filesystem: {
        allow_write: [],
        deny_read: [],
        deny_write: [],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    };

    const result = toSandboxRuntimeConfig(resolved);
    expect(result.filesystem.allowWrite).toEqual([]);
    expect(result.filesystem.denyRead).toEqual([]);
    expect(result.filesystem.denyWrite).toEqual([]);
    expect(result.network.allowedDomains).toEqual([]);
    expect(result.network.deniedDomains).toEqual([]);
  });

  it('converts multiple paths correctly', () => {
    const resolved: ResolvedSandboxConfig = {
      filesystem: {
        allow_write: ['/a', '/b', '/c'],
        deny_read: ['/x', '/y'],
        deny_write: ['/m', '/n', '/o'],
      },
      network: {
        allowed_domains: ['a.com', 'b.com'],
        denied_domains: ['c.com', 'd.com', 'e.com'],
      },
    };

    const result = toSandboxRuntimeConfig(resolved);
    expect(result.filesystem.allowWrite).toHaveLength(3);
    expect(result.filesystem.denyRead).toHaveLength(2);
    expect(result.filesystem.denyWrite).toHaveLength(3);
    expect(result.network.allowedDomains).toHaveLength(2);
    expect(result.network.deniedDomains).toHaveLength(3);
  });

  it('includes allowRead when it is an empty array', () => {
    const resolved: ResolvedSandboxConfig = {
      filesystem: {
        allow_write: ['.'],
        deny_read: [],
        deny_write: [],
        allow_read: [],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    };

    const result = toSandboxRuntimeConfig(resolved);
    expect(result.filesystem.allowRead).toEqual([]);
  });
});

// ─── wrapCommandWithSandbox ──────────────────────────────────────────────────

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    wrapWithSandbox: vi.fn().mockResolvedValue('sandbox-wrapped echo hello'),
  },
}));

describe('wrapCommandWithSandbox()', () => {
  it('calls SandboxManager.wrapWithSandbox with correct runtime config', async () => {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const sandbox: ResolvedSandboxConfig = {
      filesystem: {
        allow_write: ['/tmp'],
        deny_read: ['/secret'],
        deny_write: ['/sys'],
      },
      network: {
        allowed_domains: ['api.com'],
        denied_domains: ['evil.com'],
      },
    };

    const result = await wrapCommandWithSandbox('echo hello', sandbox);
    expect(result).toBe('sandbox-wrapped echo hello');
    expect(SandboxManager.wrapWithSandbox).toHaveBeenCalledWith('echo hello', undefined, {
      filesystem: {
        allowWrite: ['/tmp'],
        denyRead: ['/secret'],
        denyWrite: ['/sys'],
      },
      network: {
        allowedDomains: ['api.com'],
        deniedDomains: ['evil.com'],
      },
    });
  });

  it('returns original command structure when no sandbox needed', async () => {
    const sandbox: ResolvedSandboxConfig = {
      filesystem: { allow_write: [], deny_read: [], deny_write: [] },
      network: { allowed_domains: [], denied_domains: [] },
    };

    const result = await wrapCommandWithSandbox('ls -la', sandbox);
    // Mock always returns the mocked value
    expect(typeof result).toBe('string');
  });
});
