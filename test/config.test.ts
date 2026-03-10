import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../src/config/loader.js';
import { GatewayConfig } from '../src/config/schema.js';

// ─── Schema / env var substitution ───────────────────────────────────────────

describe('GatewayConfig schema', () => {
  it('parses a minimal valid config with all defaults', () => {
    const result = GatewayConfig.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.server.port).toBe(4111);
    expect(result.data.hitl.timeout_ms).toBe(300000);
    expect(result.data.security.blocked_hosts).toContain('localhost');
    expect(result.data.audit.retention_days).toBe(90);
  });

  it('substitutes ${VAR} with environment variable', () => {
    process.env['TEST_TOKEN_XYZ'] = 'my-secret';
    const result = GatewayConfig.safeParse({
      hitl: { provider: { type: 'telegram', bot_token: '${TEST_TOKEN_XYZ}', chat_id: '123' } },
    });
    delete process.env['TEST_TOKEN_XYZ'];
    expect(result.success).toBe(true);
    if (!result.success) return;
    const provider = result.data.hitl.provider as { type: 'telegram'; bot_token: string };
    expect(provider.bot_token).toBe('my-secret');
  });

  it('throws on missing required env var', () => {
    delete process.env['MISSING_VAR_XYZ'];
    expect(() => GatewayConfig.parse({
      hitl: { provider: { type: 'telegram', bot_token: '${MISSING_VAR_XYZ}', chat_id: '123' } },
    })).toThrow('MISSING_VAR_XYZ');
  });

  it('validates agent allow/hitl as arrays of strings', () => {
    const result = GatewayConfig.safeParse({
      agents: {
        agent1: {
          allow: ['github/*', 'filesystem/*'],
          hitl: ['github/create_pr'],
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
    // Valid: stdio with command
    const ok = GatewayConfig.safeParse({
      mcps: { github: { type: 'stdio', command: 'npx', args: ['-y', 'server'] } },
    });
    expect(ok.success).toBe(true);
  });

  it('defaults hitl provider to stdio', () => {
    const result = GatewayConfig.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hitl.provider.type).toBe('stdio');
  });
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

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
agents:
  helena:
    allow:
      - "github/*"
`;
    const path = join(dir, 'gateway.yaml');
    writeFileSync(path, yaml);
    const config = loadConfig(path);
    expect(config.server.port).toBe(4200);
    expect(config.agents['helena'].allow).toContain('github/*');
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
});
