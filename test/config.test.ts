import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../src/config/loader.js';
import { GatewayConfig, getBuiltinProviders, getMcpConfigs } from '../src/config/schema.js';
import { rememberAllow } from '../src/config/mutator.js';

// --- Schema / env var substitution ---

describe('GatewayConfig schema', () => {
  it('parses a minimal valid config with all defaults', () => {
    const result = GatewayConfig.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.server.port).toBe(4111);
    expect(result.data.approvals.timeout_ms).toBe(300000);
    expect(result.data.security.blocked_hosts).toContain('localhost');
    expect(result.data.audit.retention_days).toBe(90);
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
  expose_management_api: false
  expose_tools_api: false
  expose_hook_api: false
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
  expose_management_api: false
  expose_tools_api: false
  expose_hook_api: false
agents:
  agent1:
    token: agent-secret
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    const config = loadConfig(path);
    expect(config.server.auth_required).toBe(true);
    expect(config.server.expose_management_api).toBe(false);
    expect(config.agents['agent1'].token).toBe('agent-secret');
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
