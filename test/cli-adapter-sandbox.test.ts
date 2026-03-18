import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliConfig } from '../src/config/schema.js';
import type { ResolvedSandboxConfig } from '../src/sandbox/index.js';

// Mock sandbox-runtime
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    wrapWithSandbox: vi
      .fn()
      .mockImplementation((cmd: string) => Promise.resolve(`sandbox-wrap(${cmd})`)),
  },
}));

// Mock child_process
const mockKill = vi.fn();
vi.mock('child_process', () => {
  const EventEmitter = require('events');

  return {
    spawn: vi.fn().mockImplementation((_shell: string, args: string[]) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = mockKill;

      // Capture the command for verification
      const command = args?.[1] ?? '';

      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(`executed: ${command}`));
        child.emit('close', 0);
      });

      return child;
    }),
  };
});

function makeCliConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    commands: {},
    max_output_bytes: 30_000,
    ...overrides,
  };
}

const baseSandbox: ResolvedSandboxConfig = {
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

describe('CliBackendAdapter sandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wraps command with sandbox when meta.sandbox is present', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');
    const { spawn } = await import('child_process');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const config = makeCliConfig({
      commands: {
        echo: {
          exec: 'echo hello',
          params: {},
          timeout: 5,
        },
      },
    });

    const adapter = new CliBackendAdapter('test', config);

    const result = await adapter.call({
      tool: 'test/echo',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(true);
    expect(SandboxManager.wrapWithSandbox).toHaveBeenCalledWith(
      'echo hello',
      undefined,
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowWrite: ['/tmp'],
        }),
      })
    );
    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'sandbox-wrap(echo hello)'],
      expect.any(Object)
    );
  });

  it('does not wrap command when meta has no sandbox', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');
    const { spawn } = await import('child_process');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const config = makeCliConfig({
      commands: {
        echo: {
          exec: 'echo hello',
          params: {},
          timeout: 5,
        },
      },
    });

    const adapter = new CliBackendAdapter('test', config);

    const result = await adapter.call({
      tool: 'test/echo',
      args: {},
      agentId: 'agent1',
      meta: {},
    });

    expect(result.success).toBe(true);
    expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-c', 'echo hello'], expect.any(Object));
  });

  it('does not wrap command when meta is undefined', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const config = makeCliConfig({
      commands: {
        echo: {
          exec: 'echo hello',
          params: {},
          timeout: 5,
        },
      },
    });

    const adapter = new CliBackendAdapter('test', config);

    const result = await adapter.call({
      tool: 'test/echo',
      args: {},
      agentId: 'agent1',
    });

    expect(result.success).toBe(true);
    expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it('does not wrap command when meta.sandbox is undefined', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const config = makeCliConfig({
      commands: {
        echo: {
          exec: 'echo hello',
          params: {},
          timeout: 5,
        },
      },
    });

    const adapter = new CliBackendAdapter('test', config);

    const result = await adapter.call({
      tool: 'test/echo',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: undefined },
    });

    expect(result.success).toBe(true);
    expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it('wraps parameterized command with sandbox', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');
    const { spawn } = await import('child_process');

    const config = makeCliConfig({
      commands: {
        greet: {
          exec: 'echo {name}',
          params: {
            name: { type: 'string', positional: false, required: true },
          },
          timeout: 5,
        },
      },
    });

    const adapter = new CliBackendAdapter('test', config);

    const result = await adapter.call({
      tool: 'test/greet',
      args: { name: 'world' },
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(true);
    // The built command (with param substitution) should be wrapped
    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', expect.stringContaining('sandbox-wrap(')],
      expect.any(Object)
    );
  });

  it('passes correct sandbox runtime config to wrapWithSandbox', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const customSandbox: ResolvedSandboxConfig = {
      filesystem: {
        allow_write: ['/project', '/build'],
        deny_read: ['/etc/shadow'],
        deny_write: ['/usr'],
        allow_read: ['/project'],
      },
      network: {
        allowed_domains: ['npm.com', 'github.com'],
        denied_domains: ['crypto-miner.com'],
      },
    };

    const config = makeCliConfig({
      commands: {
        build: {
          exec: 'npm run build',
          params: {},
          timeout: 30,
        },
      },
    });

    const adapter = new CliBackendAdapter('npm', config);

    await adapter.call({
      tool: 'npm/build',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: customSandbox },
    });

    expect(SandboxManager.wrapWithSandbox).toHaveBeenCalledWith(
      'npm run build',
      undefined,
      expect.objectContaining({
        filesystem: {
          allowWrite: ['/project', '/build'],
          denyRead: ['/etc/shadow'],
          denyWrite: ['/usr'],
          allowRead: ['/project'],
        },
        network: {
          allowedDomains: ['npm.com', 'github.com'],
          deniedDomains: ['crypto-miner.com'],
        },
      })
    );
  });

  it('rejects wrong prefix even with sandbox', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');

    const config = makeCliConfig({
      commands: {
        echo: { exec: 'echo hi', params: {}, timeout: 5 },
      },
    });

    const adapter = new CliBackendAdapter('test', config);

    const result = await adapter.call({
      tool: 'other/echo',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not belong to adapter');
  });

  it('returns error for unknown command even with sandbox', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');

    const adapter = new CliBackendAdapter('test', makeCliConfig());

    const result = await adapter.call({
      tool: 'test/nonexistent',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown CLI command/);
  });

  it('custom shell is used for sandboxed command', async () => {
    const { CliBackendAdapter } = await import('../src/backend/cli/adapter.js');
    const { spawn } = await import('child_process');

    const config = makeCliConfig({
      shell: '/bin/bash',
      commands: {
        echo: { exec: 'echo hi', params: {}, timeout: 5 },
      },
    });

    const adapter = new CliBackendAdapter('test', config);

    await adapter.call({
      tool: 'test/echo',
      args: {},
      agentId: 'agent1',
      meta: { sandbox: baseSandbox },
    });

    expect(spawn).toHaveBeenCalledWith('/bin/bash', expect.any(Array), expect.any(Object));
  });
});
