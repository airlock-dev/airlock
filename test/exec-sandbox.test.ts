import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../src/config/schema.js';
import { GatewayConfig } from '../src/config/schema.js';
import type { ResolvedSandboxConfig } from '../src/sandbox/index.js';

// Mock sandbox-runtime before importing modules that use it
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    wrapWithSandbox: vi
      .fn()
      .mockImplementation((cmd: string) => Promise.resolve(`sandbox-wrap(${cmd})`)),
  },
}));

// Mock child_process to avoid actually spawning processes
vi.mock('child_process', () => {
  const EventEmitter = require('events');

  function createMockChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.stdio = ['ignore', child.stdout, child.stderr];
    return child;
  }

  return {
    spawn: vi.fn().mockImplementation(() => {
      const child = createMockChild();
      // Simulate immediate success
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('output'));
        child.emit('close', 0);
      });
      return child;
    }),
  };
});

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return GatewayConfig.parse({
    agents: { test: overrides },
  }).agents['test'];
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

// ─── executeExec with sandbox ────────────────────────────────────────────────

describe('executeExec with sandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wraps command with sandbox when sandbox config is provided', async () => {
    const { executeExec } = await import('../src/tools/exec.js');
    const { spawn } = await import('child_process');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const agentConfig = makeAgentConfig({
      exec: { allow: ['*'], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });

    await executeExec('echo hello', agentConfig, undefined, undefined, baseSandbox);

    expect(SandboxManager.wrapWithSandbox).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'sandbox-wrap(echo hello)'],
      expect.any(Object)
    );
  });

  it('does not wrap command when sandbox is undefined', async () => {
    const { executeExec } = await import('../src/tools/exec.js');
    const { spawn } = await import('child_process');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const agentConfig = makeAgentConfig({
      exec: { allow: ['*'], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });

    await executeExec('echo hello', agentConfig, undefined, undefined, undefined);

    expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-c', 'echo hello'], expect.any(Object));
  });

  it('passes correct runtime config to SandboxManager.wrapWithSandbox', async () => {
    const { executeExec } = await import('../src/tools/exec.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const agentConfig = makeAgentConfig({
      exec: { allow: ['*'], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });

    await executeExec('ls -la', agentConfig, undefined, undefined, baseSandbox);

    expect(SandboxManager.wrapWithSandbox).toHaveBeenCalledWith(
      'ls -la',
      undefined,
      expect.objectContaining({
        filesystem: expect.objectContaining({
          allowWrite: ['/tmp'],
          denyRead: ['/secret'],
          denyWrite: ['/sys'],
        }),
        network: expect.objectContaining({
          allowedDomains: ['api.com'],
          deniedDomains: ['evil.com'],
        }),
      })
    );
  });
});

// ─── ExecBackendAdapter with sandbox ─────────────────────────────────────────

describe('ExecBackendAdapter with sandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes meta.sandbox to executeExec', async () => {
    const { ExecBackendAdapter } = await import('../src/backend/exec-adapter.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const agentConfig = makeAgentConfig({
      exec: { allow: ['*'], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });

    const adapter = new ExecBackendAdapter({ test: agentConfig });

    const result = await adapter.call({
      tool: 'exec/run',
      args: { command: 'echo test' },
      agentId: 'test',
      meta: { sandbox: baseSandbox },
    });

    expect(result.success).toBe(true);
    expect(SandboxManager.wrapWithSandbox).toHaveBeenCalled();
  });

  it('does not wrap when meta has no sandbox', async () => {
    const { ExecBackendAdapter } = await import('../src/backend/exec-adapter.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const agentConfig = makeAgentConfig({
      exec: { allow: ['*'], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });

    const adapter = new ExecBackendAdapter({ test: agentConfig });

    const result = await adapter.call({
      tool: 'exec/run',
      args: { command: 'echo test' },
      agentId: 'test',
      meta: {},
    });

    expect(result.success).toBe(true);
    expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it('does not wrap when meta is undefined', async () => {
    const { ExecBackendAdapter } = await import('../src/backend/exec-adapter.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const agentConfig = makeAgentConfig({
      exec: { allow: ['*'], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });

    const adapter = new ExecBackendAdapter({ test: agentConfig });

    const result = await adapter.call({
      tool: 'exec/run',
      args: { command: 'echo test' },
      agentId: 'test',
    });

    expect(result.success).toBe(true);
    expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });

  it('does not wrap when meta.sandbox is undefined', async () => {
    const { ExecBackendAdapter } = await import('../src/backend/exec-adapter.js');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    const agentConfig = makeAgentConfig({
      exec: { allow: ['*'], ask: [], deny: [], env: {}, default_timeout_ms: 5000 },
    });

    const adapter = new ExecBackendAdapter({ test: agentConfig });

    const result = await adapter.call({
      tool: 'exec/run',
      args: { command: 'echo test' },
      agentId: 'test',
      meta: { sandbox: undefined },
    });

    expect(result.success).toBe(true);
    expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  });
});
