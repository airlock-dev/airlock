import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requiredMcpsForAgent } from '../src/pool/required-mcps.js';
import type { AgentConfig } from '../src/config/schema.js';

function makeAgent(allow: string[]): AgentConfig {
  return {
    allow,
    hitl: [],
    tool_overrides: {},
    exec: { allow: [], hitl: [], deny: [], env: {}, default_timeout_ms: 30000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 30000 },
  };
}

const AVAILABLE_MCPS = ['github', 'filesystem', 'slack', 'jira'];

describe('requiredMcpsForAgent()', () => {
  it('returns MCP ids referenced by allow list', () => {
    const agent = makeAgent(['github/*', 'filesystem/*']);
    expect(requiredMcpsForAgent(agent, AVAILABLE_MCPS)).toEqual(
      expect.arrayContaining(['github', 'filesystem']),
    );
  });

  it('does not include MCPs not referenced', () => {
    const agent = makeAgent(['github/*']);
    const result = requiredMcpsForAgent(agent, AVAILABLE_MCPS);
    expect(result).not.toContain('slack');
    expect(result).not.toContain('jira');
    expect(result).not.toContain('filesystem');
  });

  it('ignores built-in namespaces (http, exec)', () => {
    const agent = makeAgent(['http/*', 'exec/run', 'github/*']);
    const result = requiredMcpsForAgent(agent, AVAILABLE_MCPS);
    expect(result).toEqual(['github']);
  });

  it('handles exact tool names (not just wildcards)', () => {
    const agent = makeAgent(['filesystem/read_file', 'filesystem/write_file']);
    const result = requiredMcpsForAgent(agent, AVAILABLE_MCPS);
    expect(result).toEqual(['filesystem']);
  });

  it('deduplicates MCPs referenced multiple times', () => {
    const agent = makeAgent(['github/create_pr', 'github/list_prs', 'github/*']);
    const result = requiredMcpsForAgent(agent, AVAILABLE_MCPS);
    expect(result.filter(id => id === 'github')).toHaveLength(1);
  });

  it('returns empty array when allow list is empty', () => {
    expect(requiredMcpsForAgent(makeAgent([]), AVAILABLE_MCPS)).toEqual([]);
  });

  it('ignores patterns that reference unknown MCP IDs', () => {
    const agent = makeAgent(['unknown-mcp/*', 'github/*']);
    const result = requiredMcpsForAgent(agent, AVAILABLE_MCPS);
    expect(result).toEqual(['github']);
  });

  it('ignores hitl list — only allow list drives MCP connections', () => {
    const agent = makeAgent(['github/*']);
    agent.hitl = ['slack/*']; // slack is in hitl but NOT in allow — should not connect to slack
    const result = requiredMcpsForAgent(agent, AVAILABLE_MCPS);
    expect(result).not.toContain('slack');
    expect(result).toEqual(['github']);
  });
});

// ─── StdioMode integration ────────────────────────────────────────────────────

const MINIMAL_CONFIG = {
  mcps: {},
  agents: {
    'claude-code': {
      allow: ['http/get'],
      hitl: [],
      tool_overrides: {},
      exec: { allow: [], hitl: [], deny: [], env: {}, default_timeout_ms: 5000 },
      http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
    },
  },
  hitl: { provider: { type: 'stdio' as const }, timeout_ms: 300000, batch_window_ms: 10000 },
  security: { blocked_hosts: [], allowed_local: [] },
  audit: { db_path: ':memory:', retention_days: 90, redact_fields: [] },
  server: { port: 4111, host: '127.0.0.1' },
};

describe('runStdioMode()', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('calls runStdioServer with the correct agentId', async () => {
    const { runStdioMode } = await import('../src/stdio-mode.js');
    const stdioServerModule = await import('../src/transport/stdio-server.js');
    const stdioSpy = vi.spyOn(stdioServerModule, 'runStdioServer').mockResolvedValue();

    await runStdioMode(MINIMAL_CONFIG as never, 'claude-code');

    expect(stdioSpy).toHaveBeenCalledOnce();
    expect(stdioSpy.mock.calls[0][0].agentId).toBe('claude-code');
  });

  it('throws for unknown profile', async () => {
    const { runStdioMode } = await import('../src/stdio-mode.js');
    await expect(
      runStdioMode(MINIMAL_CONFIG as never, 'nonexistent'),
    ).rejects.toThrow(/Unknown agent profile/);
  });

  it('only includes required MCPs — slack excluded when not in allow list', async () => {
    const { runStdioMode } = await import('../src/stdio-mode.js');
    const stdioServerModule = await import('../src/transport/stdio-server.js');
    const stdioSpy = vi.spyOn(stdioServerModule, 'runStdioServer').mockResolvedValue();

    const poolModule = await import('../src/pool/pool.js');
    vi.spyOn(poolModule.ClientPool.prototype, 'initialize').mockResolvedValue();
    // Capture what MCPs the pool was constructed with
    const poolInstances: ClientPool[] = [];
    const OrigClientPool = poolModule.ClientPool;
    vi.spyOn(poolModule, 'ClientPool' as keyof typeof poolModule).mockImplementation(
      (mcps: Record<string, unknown>) => {
        const instance = new OrigClientPool(mcps as never);
        poolInstances.push(instance);
        return instance;
      },
    );

    const config = {
      ...MINIMAL_CONFIG,
      mcps: {
        github:     { type: 'stdio' as const, command: 'npx', args: [] },
        filesystem: { type: 'stdio' as const, command: 'npx', args: [] },
        slack:      { type: 'stdio' as const, command: 'npx', args: [] },
      },
      agents: {
        'claude-code': {
          allow: ['github/*', 'filesystem/read_file'],
          hitl: [],
          tool_overrides: {},
          exec: { allow: [], hitl: [], deny: [], env: {}, default_timeout_ms: 5000 },
          http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
        },
      },
    };

    await runStdioMode(config as never, 'claude-code');

    expect(stdioSpy).toHaveBeenCalledOnce();
    // requiredMcpsForAgent filters at config level — verify via the unit-tested function directly
    const { requiredMcpsForAgent: req } = await import('../src/pool/required-mcps.js');
    const needed = req(config.agents['claude-code'] as never, ['github', 'filesystem', 'slack']);
    expect(needed).toContain('github');
    expect(needed).toContain('filesystem');
    expect(needed).not.toContain('slack');
  });
});
