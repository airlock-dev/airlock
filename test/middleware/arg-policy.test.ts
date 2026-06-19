import { describe, expect, it, vi } from 'vitest';
import { argPolicyMiddleware, resolveArgPolicy } from '../../src/middleware/core/arg-policy.js';
import type { AgentConfig } from '../../src/config/schema.js';
import type { ToolCallContext, ToolCallResponse } from '../../src/middleware/types.js';

const okResponse: ToolCallResponse = { result: 'ok', text: 'ok' };
const okNext = vi.fn(async () => okResponse);

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    allow: ['google_workspace/*'],
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
  };
}

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  const agentConfig = makeAgentConfig();
  return {
    callId: 'test-call',
    agentId: 'agent1',
    agentConfig,
    toolName: 'google_workspace/manage_event',
    args: { calendar_id: 'work-calendar', action: 'create' },
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
  };
}

describe('argPolicyMiddleware', () => {
  it('passes when equals policy matches', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      agentConfig: makeAgentConfig({
        arg_policy: {
          'google_workspace/manage_event': {
            calendar_id: { equals: 'work-calendar', label: 'Work' },
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
  });

  it('denies with an actionable error when equals policy mismatches', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      args: { calendar_id: 'personal-calendar', action: 'create' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'google_workspace/manage_event': {
            calendar_id: { equals: 'work-calendar', label: 'Work' },
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toContain('calendar_id "personal-calendar" is not permitted');
    expect(result.text).toContain('Allowed calendar_id: "work-calendar" (Work)');
    expect(result.text).toContain('Retry with that value');
    expect((result.result as { isError?: boolean }).isError).toBe(true);
    expect(okNext).not.toHaveBeenCalled();
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'arg_policy_denied' })
    );
  });

  it('denies when a constrained arg is missing', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      args: { action: 'create' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'google_workspace/manage_event': {
            calendar_id: { equals: 'work-calendar', label: 'Work' },
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toContain('calendar_id is required by policy');
    expect(result.text).toContain('Allowed calendar_id: "work-calendar" (Work)');
    expect(okNext).not.toHaveBeenCalled();
  });

  it('supports allow-list constraints', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      args: { calendar_id: 'work-calendar', action: 'move' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'google_workspace/manage_event': {
            action: { allow: ['create', 'update', 'delete'] },
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toContain('action "move" is not permitted');
    expect(result.text).toContain('Allowed action: "create", "update", "delete"');
    expect(okNext).not.toHaveBeenCalled();
  });

  it('applies alias-local tool override args', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'gcal_work_write',
      agentConfig: makeAgentConfig({
        tool_overrides: {
          gcal_work_write: {
            alias_of: 'google_workspace/manage_event',
            args: {
              calendar_id: { equals: 'work-calendar', label: 'Work' },
            },
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
  });

  it('lets alias-local args override same-name direct policy', () => {
    const agentConfig = makeAgentConfig({
      arg_policy: {
        gcal_work_write: {
          calendar_id: { equals: 'wrong-calendar' },
        },
      },
      tool_overrides: {
        gcal_work_write: {
          alias_of: 'google_workspace/manage_event',
          args: {
            calendar_id: { equals: 'work-calendar', label: 'Work' },
          },
        },
      },
    });

    expect(resolveArgPolicy(agentConfig, 'gcal_work_write')).toEqual({
      calendar_id: { equals: 'work-calendar', label: 'Work' },
    });
  });
});
