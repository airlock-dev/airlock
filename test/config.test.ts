import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, loadConfigDetailed, validateConfig } from '../src/config/loader.js';
import { GatewayConfig, getBuiltinProviders, getMcpConfigs } from '../src/config/schema.js';
import { rememberAllow } from '../src/config/mutator.js';

// --- Schema / env var substitution ---

describe('GatewayConfig schema', () => {
  it('parses a minimal valid config with all defaults', () => {
    const result = GatewayConfig.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.server.port).toBe(4111);
    expect(result.data.server.expose_tools_api).toBe(true);
    expect(result.data.server.management_api).toMatchObject({
      enabled: false,
      host: '127.0.0.1',
      port: 4113,
      insecure_remote_bind: false,
    });
    expect(result.data.approvals.timeout_ms).toBe(300000);
    expect(result.data.security.blocked_hosts).toContain('localhost');
    expect(result.data.audit.retention_days).toBe(90);
  });

  it('maps deprecated management exposure aliases into the management_api block', () => {
    const result = GatewayConfig.safeParse({
      server: {
        expose_management_api: true,
        expose_hook_api: false,
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.server.management_api).toMatchObject({
      enabled: true,
      expose_hook_api: false,
    });
  });

  it('substitutes ${VAR} with environment variable', () => {
    process.env['TEST_TOKEN_XYZ'] = 'my-secret';
    const result = GatewayConfig.safeParse({
      approvals: { provider: { type: 'telegram', bot_token: '${TEST_TOKEN_XYZ}', chat_id: '123' } },
    });
    delete process.env['TEST_TOKEN_XYZ'];
    expect(result.success).toBe(true);
    if (!result.success) return;
    const provider = result.data.approvals.provider as { type: 'telegram'; bot_token: string };
    expect(provider.bot_token).toBe('my-secret');
  });

  it('throws on missing required env var', () => {
    delete process.env['MISSING_VAR_XYZ'];
    expect(() =>
      GatewayConfig.parse({
        approvals: {
          provider: { type: 'telegram', bot_token: '${MISSING_VAR_XYZ}', chat_id: '123' },
        },
      })
    ).toThrow('MISSING_VAR_XYZ');
  });

  it('validates agent allow/ask as arrays of strings', () => {
    const result = GatewayConfig.safeParse({
      agents: {
        agent1: {
          allow: ['github/*', 'filesystem/*'],
          ask: ['github/create_pr'],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agents['agent1'].allow).toEqual(['github/*', 'filesystem/*']);
  });

  it('applies agent exec defaults', () => {
    const result = GatewayConfig.safeParse({ agents: { agent1: {} } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const exec = result.data.agents['agent1'].exec;
    expect(exec.allow).toEqual([]);
    expect(exec.deny).toEqual([]);
    expect(exec.default_timeout_ms).toBe(30000);
  });

  it('validates mcp stdio type requires command', () => {
    const ok = GatewayConfig.safeParse({
      providers: { github: { type: 'stdio', command: 'npx', args: ['-y', 'server'] } },
    });
    expect(ok.success).toBe(true);
  });

  it('defaults approval provider to stdio', () => {
    const result = GatewayConfig.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.approvals.provider.type).toBe('stdio');
  });

  it('defaults dashboard approval host to loopback', () => {
    const result = GatewayConfig.safeParse({
      approvals: { provider: { type: 'dashboard', port: 4112 } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.approvals.provider).toEqual({
      type: 'dashboard',
      host: '127.0.0.1',
      port: 4112,
    });
  });

  it('accepts dashboard approval host overrides for container deployments', () => {
    const result = GatewayConfig.safeParse({
      approvals: { provider: { type: 'dashboard', host: '0.0.0.0', port: 4112 } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.approvals.provider).toMatchObject({
      type: 'dashboard',
      host: '0.0.0.0',
    });
  });

  it('accepts builtin string shorthand for providers', () => {
    const result = GatewayConfig.safeParse({
      providers: { exec: 'builtin', http: 'builtin' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.providers['exec']).toBe('builtin');
    expect(result.data.providers['http']).toBe('builtin');
  });

  it('accepts disabled providers', () => {
    const result = GatewayConfig.safeParse({
      providers: {
        exec: { type: 'builtin', enabled: false },
        github: { type: 'stdio', enabled: false, command: 'npx', args: ['server'] },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.providers['exec']).toEqual({ type: 'builtin', enabled: false });
    expect(result.data.providers['github']).toMatchObject({ type: 'stdio', enabled: false });
    expect(getBuiltinProviders(result.data.providers).has('exec')).toBe(false);
    expect(getMcpConfigs(result.data.providers)).toEqual({});
  });

  it('supports deny list on agents', () => {
    const result = GatewayConfig.safeParse({
      agents: {
        agent1: {
          allow: ['github/*'],
          deny: ['github/delete_repo'],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agents['agent1'].deny).toEqual(['github/delete_repo']);
  });

  it('supports profile extends', () => {
    const result = GatewayConfig.safeParse({
      profiles: {
        readonly: { allow: ['github/list*'] },
        product: { extends: ['readonly'], ask: ['github/create_issue'] },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.profiles['product'].extends).toEqual(['readonly']);
  });

  it('supports per-tool argument policy on agents', () => {
    const result = GatewayConfig.safeParse({
      agents: {
        agent1: {
          allow: ['google_workspace/manage_event'],
          arg_policy: {
            'google_workspace/manage_event': {
              calendar_id: { equals: 'work-calendar', label: 'Work' },
              action: { allow: ['create', 'update', 'delete'] },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agents['agent1'].arg_policy).toEqual({
      'google_workspace/manage_event': {
        calendar_id: [{ equals: 'work-calendar', label: 'Work' }],
        action: [{ allow: ['create', 'update', 'delete'] }],
      },
    });
  });

  it('supports argument policy on tool override aliases', () => {
    const result = GatewayConfig.safeParse({
      agents: {
        agent1: {
          allow: ['gcal_work_write'],
          tool_overrides: {
            gcal_work_write: {
              alias_of: 'google_workspace/manage_event',
              description:
                'Manage events on the Work calendar only. calendar_id must be work-calendar.',
              args: {
                calendar_id: { equals: 'work-calendar', label: 'Work' },
              },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agents['agent1'].tool_overrides.gcal_work_write.args).toEqual({
      calendar_id: [{ equals: 'work-calendar', label: 'Work' }],
    });
  });

  it('supports value sets, argument dimensions, and profile arg scope', () => {
    const result = GatewayConfig.safeParse({
      value_sets: {
        airlock_repos: ['airlock-dev/airlock'],
        safe_fix_branches: { values: ['fix/*', 'feat/*'] },
      },
      arg_dimensions: {
        github_repo: {
          match: 'in',
          bindings: {
            'github/create_pull_request': 'repo',
            'github/push_files': 'repo',
          },
        },
        github_branch: {
          match: 'glob_in',
          bindings: {
            'github/create_pull_request': 'head',
            'github/push_files': 'branch',
          },
        },
      },
      profiles: {
        airlock_autofix: {
          allow: ['github/create_pull_request', 'github/push_files'],
          arg_scope: {
            github_repo: 'airlock_repos',
            github_branch: 'safe_fix_branches',
          },
        },
      },
      agents: {
        agent1: {
          extends: ['airlock_autofix'],
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.value_sets.airlock_repos).toEqual({
      values: ['airlock-dev/airlock'],
      expose_values: true,
    });
    expect(result.data.profiles.airlock_autofix.arg_scope).toEqual({
      github_repo: ['airlock_repos'],
      github_branch: ['safe_fix_branches'],
    });
  });

  it('rejects empty argument policy constraints', () => {
    const result = GatewayConfig.safeParse({
      agents: {
        agent1: {
          allow: ['google_workspace/manage_event'],
          arg_policy: {
            'google_workspace/manage_event': {
              calendar_id: {},
              action: { allow: [] },
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.toString()).toContain('must define exactly one matcher');
    expect(result.error.toString()).toContain('allow list must contain at least one value');
  });
});

// --- loadConfig ---

describe('loadConfig()', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-cfg-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it('loads a valid YAML config file', () => {
    const yaml = `
server:
  port: 4200
providers:
  echo:
    type: stdio
    command: echo
    args: ["hello"]
agents:
  helena:
    allow:
      - "echo/*"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    const config = loadConfig(path);
    expect(config.server.port).toBe(4200);
    expect(config.agents['helena'].allow).toContain('echo/*');
  });

  it('throws on invalid config with helpful message', () => {
    const yaml = `server:\n  port: "not-a-number"\n`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/Invalid config/);
  });

  it('throws on missing file', () => {
    expect(() => loadConfig('/nonexistent/path/gateway.yaml')).toThrow();
  });

  it('substitutes env vars from YAML', () => {
    process.env['TEST_AGENT_SECRET'] = 'supersecret';
    const yaml = `server:\n  api_secret: "\${TEST_AGENT_SECRET}"\n`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    const config = loadConfig(path);
    delete process.env['TEST_AGENT_SECRET'];
    expect(config.server.api_secret).toBe('supersecret');
  });

  it('can validate structure without resolving env vars', () => {
    delete process.env['TEST_AGENT_SECRET'];
    const yaml = `
server:
  auth_required: true
  api_secret: "\${TEST_AGENT_SECRET}"
agents:
  agent1:
    token: "\${TEST_AGENT_SECRET}"
    allow:
      - "github/*"
providers:
  github: builtin
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    expect(() => loadConfig(path)).toThrow(/TEST_AGENT_SECRET/);

    const result = loadConfigDetailed(path, { resolveEnv: false });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([]);
    expect(result.config?.server.api_secret).toBe('${TEST_AGENT_SECRET}');
    expect(result.config?.agents['agent1'].token).toBe('${TEST_AGENT_SECRET}');
  });

  it('substitutes env vars in the management API secret', () => {
    process.env['TEST_MANAGEMENT_SECRET'] = 'management-supersecret';
    const yaml = `
server:
  management_api:
    api_secret: "\${TEST_MANAGEMENT_SECRET}"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    const config = loadConfig(path);
    delete process.env['TEST_MANAGEMENT_SECRET'];
    expect(config.server.management_api.api_secret).toBe('management-supersecret');
  });

  it('errors when binding beyond loopback without required auth', () => {
    const yaml = `
server:
  host: 0.0.0.0
agents:
  agent1:
    token: agent-secret
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/auth_required/i);
  });

  it('errors when auth is required but an agent has no token and no global secret exists', () => {
    const yaml = `
server:
  auth_required: true
  management_api:
    enabled: false
agents:
  agent1: {}
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/some agents have no token/i);
  });

  it('allows MCP-only exposure with per-agent tokens and no global admin secret', () => {
    const yaml = `
server:
  auth_required: true
  require_agent_tokens: true
  allowed_origins:
    - https://airlock.internal
  management_api:
    enabled: false
agents:
  agent1:
    token: agent-secret
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    const config = loadConfig(path);
    expect(config.server.auth_required).toBe(true);
    expect(config.server.management_api.enabled).toBe(false);
    expect(config.agents['agent1'].token).toBe('agent-secret');
  });

  it('errors when the management API is enabled without any control-plane credential', () => {
    const yaml = `
server:
  management_api:
    enabled: true
agents:
  agent1:
    token: agent-secret
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(
      /management_api\.enabled requires server\.management_api\.api_secret or server\.api_secret/i
    );
  });

  it('warns when management API falls back to server.api_secret', () => {
    const config = GatewayConfig.parse({
      server: {
        api_secret: 'shared-secret',
        management_api: {
          enabled: true,
        },
      },
      agents: {
        agent1: { token: 'agent-secret' },
      },
    });

    const diagnostics = validateConfig(config);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message:
            'management_api is using server.api_secret; set server.management_api.api_secret to separate the control-plane secret from the data-plane fallback.',
        }),
      ])
    );
  });

  it('warns when management and data-plane secrets resolve to the same value', () => {
    process.env['TEST_SHARED_AIRLOCK_SECRET'] = 'same-secret';
    const yaml = `
server:
  api_secret: "\${TEST_SHARED_AIRLOCK_SECRET}"
  management_api:
    enabled: true
    api_secret: "\${TEST_SHARED_AIRLOCK_SECRET}"
agents:
  agent1:
    token: agent-secret
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    const config = loadConfig(path);
    delete process.env['TEST_SHARED_AIRLOCK_SECRET'];

    const diagnostics = validateConfig(config);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining(
            'server.management_api.api_secret matches server.api_secret'
          ),
        }),
      ])
    );
  });

  it('errors when the management API is enabled with tokenless agents', () => {
    const yaml = `
server:
  api_secret: admin-secret
  management_api:
    enabled: true
agents:
  agent1: {}
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/Per-agent tokens are required/i);
  });

  it('errors when the management API binds beyond loopback without insecure_remote_bind', () => {
    const yaml = `
server:
  api_secret: admin-secret
  management_api:
    enabled: true
    host: 0.0.0.0
agents:
  agent1:
    token: agent-secret
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/insecure_remote_bind/i);
  });

  it('errors when the management API shares the data-plane port', () => {
    const yaml = `
server:
  port: 4111
  api_secret: admin-secret
  management_api:
    enabled: true
    port: 4111
agents:
  agent1:
    token: agent-secret
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/must not share a socket/i);
  });

  it('warns when deprecated management exposure aliases are used', () => {
    const config = GatewayConfig.parse({
      server: {
        api_secret: 'admin-secret',
        expose_management_api: true,
      },
      agents: {
        agent1: { token: 'agent-secret' },
      },
    });

    const diagnostics = validateConfig(config);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('expose_management_api is deprecated'),
        }),
      ])
    );
  });

  it('errors when per-agent tokens are required and an agent has no token', () => {
    const yaml = `
server:
  auth_required: true
  require_agent_tokens: true
  api_secret: global-admin-secret
agents:
  selene: {}
  codex:
    token: codex-secret
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/Per-agent tokens are required/i);
  });

  it('requires per-agent tokens automatically when binding beyond loopback', () => {
    const yaml = `
server:
  host: 0.0.0.0
  auth_required: true
  api_secret: global-admin-secret
agents:
  selene: {}
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/Per-agent tokens are required/i);
  });

  it('errors when agent references unknown provider', () => {
    const yaml = `
providers:
  echo:
    type: stdio
    command: echo
agents:
  agent1:
    allow:
      - "unknown_mcp/*"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    expect(() => loadConfig(path)).toThrow(/unknown provider/i);
  });

  it('resolves profile inheritance before validating agent providers', () => {
    const yaml = `
providers:
  github: builtin
profiles:
  readonly:
    allow:
      - "github/list*"
  product:
    extends:
      - readonly
    ask:
      - "github/create_issue"
agents:
  dev:
    extends:
      - product
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    const config = loadConfig(path);

    expect(config.profiles['product'].extends).toEqual([]);
    expect(config.agents['dev'].extends).toEqual([]);
    expect(config.agents['dev'].allow).toEqual(['github/list*']);
    expect(config.agents['dev'].ask).toEqual(['github/create_issue']);
  });

  it('errors when a profile extends an unknown profile', () => {
    const yaml = `
profiles:
  product:
    extends:
      - missing
agents:
  dev:
    extends:
      - product
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    expect(() => loadConfig(path)).toThrow(/Profile "product" extends unknown profile "missing"/);
  });

  it('errors when profile inheritance has a cycle', () => {
    const yaml = `
profiles:
  pa-work:
    extends:
      - product
  product:
    extends:
      - pa-work
agents:
  dev:
    extends:
      - pa-work
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    expect(() => loadConfig(path)).toThrow(/pa-work -> product -> pa-work/);
  });

  it('reports unknown keys during ordinary config load with typo suggestions', () => {
    const yaml = `
providers:
  github: builtin
agents:
  dev:
    allow:
      - "github/*"
    scope:
      github_repo: airlock_repos
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    const result = loadConfigDetailed(path);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: 'Unrecognized key "scope" in agent "dev".',
          suggestion: 'Did you mean "arg_scope"?',
        }),
      ])
    );
  });

  it('rejects unknown profile keys at the schema layer', () => {
    const result = GatewayConfig.safeParse({
      profiles: {
        personal: {
          allow: ['github/*'],
          scope: { github_repo: 'airlock_repos' },
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.toString()).toContain('Unrecognized key');
    expect(result.error.toString()).toContain('scope');
  });

  it('reports missing arg_scope value_set references without starting the gateway', () => {
    const yaml = `
providers:
  github: builtin
arg_dimensions:
  github_repo:
    bindings:
      github/push_files: repo
profiles:
  repo_bound:
    arg_scope:
      github_repo: missing_repos
agents:
  dev:
    extends:
      - repo_bound
    allow:
      - "github/push_files"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    const result = loadConfigDetailed(path);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('missing_repos'),
        }),
      ])
    );
  });

  it('allows tool override alias namespaces in allow rules', () => {
    const yaml = `
providers:
  exec: builtin
agents:
  dev:
    allow:
      - "python/sandboxed"
    tool_overrides:
      python/sandboxed:
        alias_of: "exec/run"
        description: "Run Python in a sandbox"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    const result = loadConfigDetailed(path);

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('unknown provider "python"'),
        }),
      ])
    );
  });

  it('reports missing arg_scope dimensions without throwing from desugar', () => {
    const yaml = `
providers:
  github: builtin
value_sets:
  airlock_repos:
    - airlock-dev/airlock
profiles:
  repo_bound:
    arg_scope:
      github_repo: airlock_repos
agents:
  dev:
    extends:
      - repo_bound
    allow:
      - "github/push_files"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    const result = loadConfigDetailed(path);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('unknown arg_dimension "github_repo"'),
        }),
      ])
    );
  });

  it('reports missing arg_policy value_set references without throwing from desugar', () => {
    const yaml = `
providers:
  github: builtin
agents:
  dev:
    allow:
      - "github/create_pull_request"
    arg_policy:
      github/create_pull_request:
        repo:
          in: missing_repos
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    const result = loadConfigDetailed(path);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('missing_repos'),
        }),
      ])
    );
  });

  it('errors when a declared arg_scope resolves to no effective constraints', () => {
    const yaml = `
providers:
  github: builtin
value_sets:
  airlock_repos:
    - airlock-dev/airlock
arg_dimensions:
  github_repo:
    bindings: {}
profiles:
  repo_bound:
    arg_scope:
      github_repo: airlock_repos
agents:
  dev:
    extends:
      - repo_bound
    allow:
      - "github/push_files"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    const result = loadConfigDetailed(path);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: 'arg_dimensions.github_repo.bindings is empty.',
        }),
        expect.objectContaining({
          level: 'error',
          agent: 'dev',
          message: expect.stringContaining('resolves to zero effective argument constraints'),
        }),
      ])
    );
  });

  it('warns when YAML parses a string-like value_set member as a number', () => {
    const yaml = `
providers:
  sms: builtin
value_sets:
  allowed_numbers:
    - +16085153685
arg_dimensions:
  sms_recipient:
    normalize:
      - phone
    bindings:
      sms/send: to
profiles:
  personal_sms:
    arg_scope:
      sms_recipient: allowed_numbers
agents:
  dev:
    extends:
      - personal_sms
    allow:
      - "sms/send"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);

    const result = loadConfigDetailed(path);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('value 16085153685 looks like an unquoted string'),
          suggestion: expect.stringContaining('"+16085153685"'),
        }),
      ])
    );
    expect(result.diagnostics.some((diagnostic) => diagnostic.level === 'error')).toBe(false);
  });
});

describe('rememberAllow()', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-cfg-mutate-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it('adds an always-allow rule only to the requester agent', () => {
    const path = join(dir, 'gateway.yaml');
    writeFileSync(
      path,
      `
providers:
  github: builtin
agents:
  requester:
    ask:
      - "github/create_pr"
  other:
    ask:
      - "github/create_pr"
`
    );

    rememberAllow({
      configPath: path,
      agentId: 'requester',
      tool: 'github/create_pr',
      mode: 'always',
    });
    const config = loadConfig(path);

    expect(config.agents['requester'].allow).toContain('github/create_pr');
    expect(config.agents['requester'].remember_allow).toContainEqual({ tool: 'github/create_pr' });
    expect(config.agents['requester'].ask).not.toContain('github/create_pr');
    expect(config.agents['other'].allow).not.toContain('github/create_pr');
    expect(config.agents['other'].ask).toContain('github/create_pr');
  });

  it('adds an expiring temporary allow rule and prunes expired entries', () => {
    const path = join(dir, 'gateway.yaml');
    writeFileSync(
      path,
      `
providers:
  github: builtin
agents:
  requester:
    ask:
      - "github/create_pr"
    remember_allow:
      - tool: "old/tool"
        expires_at: "2020-01-01T00:00:00.000Z"
`
    );

    const now = new Date('2026-05-26T10:00:00.000Z');
    const result = rememberAllow({
      configPath: path,
      agentId: 'requester',
      tool: 'github/create_pr',
      mode: 'temporary',
      durationMs: 60 * 60 * 1000,
      now,
    });
    const raw = readFileSync(path, 'utf8');
    const config = loadConfig(path);

    expect(result.expiresAt).toBe('2026-05-26T11:00:00.000Z');
    expect(raw).toContain('remember_allow');
    expect(config.agents['requester'].remember_allow).toEqual([
      { tool: 'github/create_pr', expires_at: '2026-05-26T11:00:00.000Z' },
    ]);
    expect(config.agents['requester'].ask).toContain('github/create_pr');
  });
});
