import { describe, expect, it, vi } from 'vitest';
import {
  commandPolicyMiddleware,
  evaluateCommandPolicy,
} from '../../src/middleware/core/command-policy.js';
import type { AgentConfig } from '../../src/config/schema.js';
import type { ToolCallContext, ToolCallResponse } from '../../src/middleware/types.js';

const okResponse: ToolCallResponse = { result: 'ok', text: 'ok' };
const okNext = vi.fn(async () => okResponse);

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    allow: ['posthog/exec'],
    remember_allow: [],
    ask: [],
    deny: [],
    tool_overrides: {},
    exec: { allow: [], ask: [], deny: [], env: {}, default_timeout_ms: 30000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 30000 },
    sandbox: {
      enabled: false,
      presets: [],
      filesystem: { allow_write: ['.', '/tmp'], deny_read: [], deny_write: [] },
      network: { allowed_domains: [], denied_domains: [] },
      overrides: {},
    },
    ...overrides,
  } as AgentConfig;
}

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  const agentConfig = makeAgentConfig();
  return {
    callId: 'test-call',
    agentId: 'agent1',
    agentConfig,
    toolName: 'posthog/exec',
    args: { command: 'call query-trends {}' },
    meta: {},
    deps: {
      registry: {} as any,
      allowlist: {} as any,
      hitlEngine: {} as any,
      hitlBatcher: {} as any,
      auditLogger: { log: vi.fn() } as any,
      securityConfig: { blocked_hosts: [], allowed_local: [] },
    },
    startedAt: Date.now(),
    ...overrides,
  } as ToolCallContext;
}

const READ_ONLY = {
  'posthog/exec': {
    command: {
      allow: ['tools', 'search *', 'info *', 'call query-* *', 'call *-get *', 'call *-list *'],
      ask: ['call insight-* *', 'call dashboard-* *', 'call *feature-flag* *', 'call experiment-* *'],
      deny: ['* --confirm *', 'call switch-* *'],
    },
  },
};

describe('evaluateCommandPolicy', () => {
  const rule = READ_ONLY['posthog/exec'].command;

  it('allows a matched read command', () => {
    expect(evaluateCommandPolicy('call query-trends {}', rule)).toBe('allow');
    expect(evaluateCommandPolicy('info query-trends', rule)).toBe('allow');
    expect(evaluateCommandPolicy('tools', rule)).toBe('allow');
  });

  it('asks for a write command that only matches the ask list', () => {
    expect(evaluateCommandPolicy('call insight-create {}', rule)).toBe('ask');
  });

  it('denies via deny even when ask would match (deny wins)', () => {
    expect(evaluateCommandPolicy('call feature-flag-delete --confirm {}', rule)).toBe('deny');
    expect(evaluateCommandPolicy('call switch-organization {}', rule)).toBe('deny');
  });

  it('denies an unmatched command (fail-closed)', () => {
    expect(evaluateCommandPolicy('something-else', { allow: ['tools'], ask: [], deny: [] })).toBe(
      'deny'
    );
  });

  it('matches mid-string globs across flags', () => {
    expect(evaluateCommandPolicy('call --json query-trends {}', { allow: ['call *query-* *'], ask: [], deny: [] })).toBe('allow');
  });

  it('falls to default for unmatched commands', () => {
    expect(evaluateCommandPolicy('call insight-create {}', { allow: ['call query-* *'], ask: [], deny: ['* --confirm *'], default: 'ask' })).toBe('ask');
    expect(evaluateCommandPolicy('call query-trends {}', { allow: ['call query-* *'], ask: [], deny: [], default: 'ask' })).toBe('allow');
    expect(evaluateCommandPolicy('call feature-flag-delete --confirm {}', { allow: [], ask: [], deny: ['* --confirm *'], default: 'ask' })).toBe('deny');
  });
});

describe('commandPolicyMiddleware', () => {
  it('passes through when the tool has no policy', async () => {
    okNext.mockClear();
    const mw = commandPolicyMiddleware();
    const ctx = makeCtx(); // agentConfig has no command_policy
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
  });

  it('allows a read command', async () => {
    okNext.mockClear();
    const mw = commandPolicyMiddleware();
    const ctx = makeCtx({
      args: { command: 'call query-trends {}' },
      agentConfig: makeAgentConfig({ command_policy: READ_ONLY }),
    });
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
    expect(ctx.meta.needsApproval).toBeUndefined();
  });

  it('escalates a write command to HITL', async () => {
    okNext.mockClear();
    const mw = commandPolicyMiddleware();
    const ctx = makeCtx({
      args: { command: 'call insight-create {}' },
      agentConfig: makeAgentConfig({ command_policy: READ_ONLY }),
    });
    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
    expect(ctx.meta.needsApproval).toBe(true);
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'command_policy_ask' })
    );
  });

  it('denies a destructive command with an actionable error', async () => {
    okNext.mockClear();
    const mw = commandPolicyMiddleware();
    const ctx = makeCtx({
      args: { command: 'call feature-flag-delete --confirm {}' },
      agentConfig: makeAgentConfig({ command_policy: READ_ONLY }),
    });
    const result = await mw(ctx, okNext);
    expect((result.result as { isError?: boolean }).isError).toBe(true);
    expect(result.text).toContain('is not permitted for posthog/exec');
    expect(okNext).not.toHaveBeenCalled();
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'command_policy_denied' })
    );
  });

  it('denies an unmatched command (fail-closed)', async () => {
    okNext.mockClear();
    const mw = commandPolicyMiddleware();
    const ctx = makeCtx({
      args: { command: 'call some-new-destructive-tool {}' },
      agentConfig: makeAgentConfig({
        command_policy: { 'posthog/exec': { command: { allow: ['call query-* *'], ask: [], deny: [] } } },
      }),
    });
    const result = await mw(ctx, okNext);
    expect((result.result as { isError?: boolean }).isError).toBe(true);
    expect(okNext).not.toHaveBeenCalled();
  });

  it('denies when the command arg is missing or not a string', async () => {
    okNext.mockClear();
    const mw = commandPolicyMiddleware();
    const ctx = makeCtx({
      args: {},
      agentConfig: makeAgentConfig({ command_policy: READ_ONLY }),
    });
    const result = await mw(ctx, okNext);
    expect((result.result as { isError?: boolean }).isError).toBe(true);
    expect(result.text).toContain('must be a string command');
    expect(okNext).not.toHaveBeenCalled();
  });
});
