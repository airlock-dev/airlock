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
            calendar_id: [{ equals: 'work-calendar', label: 'Work' }],
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
            calendar_id: [{ equals: 'work-calendar', label: 'Work' }],
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
            calendar_id: [{ equals: 'work-calendar', label: 'Work' }],
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
            action: [{ allow: ['create', 'update', 'delete'] }],
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
              calendar_id: [{ equals: 'work-calendar', label: 'Work' }],
            },
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
  });

  it('keeps alias-local args additive instead of replacing direct policy', () => {
    const agentConfig = makeAgentConfig({
      arg_policy: {
        gcal_work_write: {
          calendar_id: [{ equals: 'wrong-calendar' }],
        },
      },
      tool_overrides: {
        gcal_work_write: {
          alias_of: 'google_workspace/manage_event',
          args: {
            calendar_id: [{ equals: 'work-calendar', label: 'Work' }],
          },
        },
      },
    });

    expect(resolveArgPolicy(agentConfig, 'gcal_work_write')).toEqual({
      calendar_id: [{ equals: 'wrong-calendar' }, { equals: 'work-calendar', label: 'Work' }],
    });
  });

  it('applies canonical policy to alias tools and ANDs alias-local constraints', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'safe_pr',
      args: { repo: 'airlock-dev/airlock', head: 'main' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'github/create_pull_request': {
            repo: [{ allow: ['airlock-dev/airlock'], label: 'airlock_repos' }],
          },
        },
        tool_overrides: {
          safe_pr: {
            alias_of: 'github/create_pull_request',
            args: {
              head: [{ glob_allow: ['fix/*'], label: 'safe_fix_branches' }],
            },
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toContain('head "main" is not permitted');
    expect(okNext).not.toHaveBeenCalled();
  });

  it('supports glob, normalization, nested paths, and list-aware membership', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'gwsWork/manage_event',
      args: {
        event: {
          attendees: [{ email: ' Alice@Example.com ' }, { email: 'bob@example.com' }],
        },
      },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'gwsWork/manage_event': {
            'event.attendees[].email': [
              {
                path: 'event.attendees[].email',
                each_allow: ['alice@example.com', 'bob@example.com'],
                normalize: ['email'],
                label: 'trusted_people',
              },
            ],
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
  });

  it('blocks list-aware membership when one value is outside the set', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'bluebubbles/send_message',
      args: { recipients: ['+1 (608) 555-1234', '+1 (999) 555-0000'] },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'bluebubbles/send_message': {
            recipients: [
              {
                each_allow: ['+16085551234'],
                normalize: ['phone'],
                label: 'trusted_people',
              },
            ],
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toContain('recipients');
    expect(result.text).toContain('trusted_people');
    expect(okNext).not.toHaveBeenCalled();
  });

  it('passes glob constraints', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'github/push_files',
      args: { branch: 'fix/arg-scope' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'github/push_files': {
            branch: [{ glob_allow: ['fix/*', 'feat/*'], label: 'safe_branches' }],
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
  });

  it('escalates to HITL instead of denying when on_miss is ask', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'posthog/exec',
      args: { command: 'call feature-flag-delete {"id": 42}' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'posthog/exec': {
            command: [
              {
                glob_allow: ['tools', 'search *', 'info *', 'call query-* *'],
                label: 'read_only',
                on_miss: 'ask',
              },
            ],
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
    expect(ctx.meta.needsApproval).toBe(true);
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'arg_policy_ask' })
    );
  });

  it('does not ask when an on_miss:ask constraint is satisfied', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'posthog/exec',
      args: { command: 'call query-trends {}' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'posthog/exec': {
            command: [{ glob_allow: ['call query-* *'], on_miss: 'ask' }],
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
    expect(ctx.meta.needsApproval).toBeUndefined();
  });

  it('escalates to HITL when a required arg is missing and on_miss is ask', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'posthog/exec',
      args: {},
      agentConfig: makeAgentConfig({
        arg_policy: {
          'posthog/exec': {
            command: [{ glob_allow: ['call query-* *'], on_miss: 'ask' }],
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect(result.text).toBe('ok');
    expect(okNext).toHaveBeenCalledOnce();
    expect(ctx.meta.needsApproval).toBe(true);
  });

  it('lets a hard deny win over a pending ask on the same call', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'posthog/exec',
      args: { command: 'call feature-flag-delete {}', project: 'prod' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'posthog/exec': {
            command: [{ glob_allow: ['call query-* *'], on_miss: 'ask' }],
            project: [{ allow: ['sandbox'], label: 'sandbox_only' }],
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect((result.result as { isError?: boolean }).isError).toBe(true);
    expect(result.text).toContain('project "prod" is not permitted');
    expect(okNext).not.toHaveBeenCalled();
    expect(ctx.deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'arg_policy_denied' })
    );
  });

  it('defaults to deny when on_miss is unset (backward compatible)', async () => {
    okNext.mockClear();
    const mw = argPolicyMiddleware();
    const ctx = makeCtx({
      toolName: 'posthog/exec',
      args: { command: 'call feature-flag-delete {}' },
      agentConfig: makeAgentConfig({
        arg_policy: {
          'posthog/exec': {
            command: [{ glob_allow: ['call query-* *'] }],
          },
        },
      }),
    });

    const result = await mw(ctx, okNext);
    expect((result.result as { isError?: boolean }).isError).toBe(true);
    expect(okNext).not.toHaveBeenCalled();
    expect(ctx.meta.needsApproval).toBeUndefined();
  });
});
