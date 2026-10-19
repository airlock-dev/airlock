import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { ActivityStream, AirlockActivitySeverity } from '../activity/stream.js';
import type { AgentConfig } from '../config/schema.js';
import type { ProviderConnectionStatus } from '../pool/status.js';
import type { AgentVisibleTool } from '../registry/registry.js';
import {
  AIRLOCK_ASK_USER_TOOL,
  AIRLOCK_AWAIT_APPROVAL_TOOL,
  AIRLOCK_LIST_PROVIDER_TOOLS_TOOL,
  AIRLOCK_LOG_TOOL,
  AIRLOCK_NOTIFY_USER_TOOL,
  AIRLOCK_REQUEST_APPROVAL_TOOL,
  AIRLOCK_STATUS_TOOL,
  isAirlockApprovalTool,
  isAirlockTool,
} from '../airlock/tools.js';
import { extractAirlockContext } from '../airlock/context.js';
import { fingerprintCall } from '../hitl/grants.js';
import type { PlanEntry } from '../hitl/engine.js';
import { bestSpecificity, matches, specificity } from '../allowlist/pattern.js';

export interface AirlockBackendDeps {
  hitlEngine?: HitlEngine;
  hitlBatcher?: HitlBatcher;
  activityStream?: ActivityStream;
  getAgentTools?: (agentId: string) => AgentVisibleTool[];
  getAgentConfig?: (agentId: string) => AgentConfig | undefined;
  getKnownProviderIds?: () => string[];
  getProviderConnectionStatus?: (providerId: string) => ProviderConnectionStatus | undefined;
}

type ToolDecision = AgentVisibleTool['decision'];

const MAX_PLAN_CALLS = 50;
const DEFAULT_AWAIT_SECONDS = 30;
// Stay well under the ~60s request timeout many MCP clients apply.
const MAX_AWAIT_SECONDS = 50;

interface ToolCounts {
  allow: number;
  ask: number;
  total: number;
}

interface ProviderBucket {
  id: string;
  status: ProviderConnectionStatus;
  toolCounts: ToolCounts;
  tools: Record<ToolDecision, Array<Record<string, unknown>>>;
}

export class AirlockBackendAdapter implements BackendAdapter {
  readonly id = 'builtin:airlock';

  /**
   * @param approvalToolsOnly Expose only the approval tools. Used when the `airlock` builtin isn't
   *   configured: the gateway still needs request/await approval, but agents with wildcard allows
   *   must not silently gain ask_user, notify_user and friends.
   */
  constructor(
    private deps: AirlockBackendDeps = {},
    private approvalToolsOnly = false
  ) {}

  listTools(): Promise<Tool[]> {
    return Promise.resolve(
      this.allTools().filter((tool) => !this.approvalToolsOnly || isAirlockApprovalTool(tool.name))
    );
  }

  private allTools(): Tool[] {
    return [
      {
        name: AIRLOCK_ASK_USER_TOOL,
        description:
          'Ask the user a blocking yes/no question through Airlock. This is for explicit human input, not for bypassing normal tool policy.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The concise question to show the user.',
            },
            context: {
              type: 'string',
              description: 'Optional factual context explaining why you are asking now.',
            },
          },
          required: ['question'],
          additionalProperties: false,
        },
      },
      {
        name: AIRLOCK_NOTIFY_USER_TOOL,
        description:
          'Send an informational Airlock notification to the user. This does not request or grant permission.',
        inputSchema: activityInputSchema('Notification body shown to the user.'),
      },
      {
        name: AIRLOCK_LOG_TOOL,
        description:
          'Add a quiet Airlock activity log entry. This does not notify the user and does not request or grant permission.',
        inputSchema: activityInputSchema('Log body recorded in the Airlock activity stream.'),
      },
      {
        name: AIRLOCK_STATUS_TOOL,
        description:
          'Show the Airlock-visible provider connection status for this agent, including counts of allow and ask tools. Denied tools and hidden providers are omitted.',
        inputSchema: optionalProviderInputSchema(),
      },
      {
        name: AIRLOCK_REQUEST_APPROVAL_TOOL,
        description:
          'Ask the user to approve several tool calls at once, before making them. Use this when you already know you need multiple calls to tools that require approval (for example reading 10 emails): the user approves the whole list in one step instead of being asked once per call. After approval, make each call exactly as listed (same tool, identical arguments); they then run without further prompts. Tools that do not need approval can be left out. Approval is valid for a limited time and each listed call can be used once.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Why you need these calls now. Shown to the user.',
            },
            calls: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_PLAN_CALLS,
              description: 'The exact calls you intend to make.',
              items: {
                type: 'object',
                properties: {
                  tool: { type: 'string', description: 'Tool name as you would call it.' },
                  arguments: {
                    type: 'object',
                    description: 'The exact arguments you will pass.',
                  },
                },
                required: ['tool'],
              },
            },
          },
          required: ['reason', 'calls'],
          additionalProperties: false,
        },
      },
      {
        name: AIRLOCK_AWAIT_APPROVAL_TOOL,
        description:
          'Wait for a pending Airlock approval to be decided. Use the approval id from an "Approval pending" response. Returns pending, approved, denied, timeout or cancelled. Safe to call repeatedly; each call waits at most ~50 seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The approval id.' },
            wait_seconds: {
              type: 'number',
              description: `How long to wait for a decision (default ${DEFAULT_AWAIT_SECONDS}, max ${MAX_AWAIT_SECONDS}).`,
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      {
        name: AIRLOCK_LIST_PROVIDER_TOOLS_TOOL,
        description:
          'List this agent’s visible provider tools grouped by provider, connection status, and Airlock policy decision. Denied tools are omitted.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              description: 'Optional provider id to inspect, such as "github" or "filesystem".',
            },
            include_schema: {
              type: 'boolean',
              description: 'Include each tool input schema. Defaults to false.',
            },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    if (this.approvalToolsOnly && !isAirlockApprovalTool(toolCall.tool)) {
      return { success: false, error: `Unknown Airlock tool: ${toolCall.tool}` };
    }
    if (toolCall.tool === AIRLOCK_ASK_USER_TOOL) {
      return this.askUser(toolCall);
    }
    if (toolCall.tool === AIRLOCK_NOTIFY_USER_TOOL) {
      return this.activity(toolCall, 'notification');
    }
    if (toolCall.tool === AIRLOCK_LOG_TOOL) {
      return this.activity(toolCall, 'log');
    }
    if (toolCall.tool === AIRLOCK_STATUS_TOOL) {
      return this.status(toolCall);
    }
    if (toolCall.tool === AIRLOCK_LIST_PROVIDER_TOOLS_TOOL) {
      return this.listProviderTools(toolCall);
    }
    if (toolCall.tool === AIRLOCK_REQUEST_APPROVAL_TOOL) {
      return this.requestApproval(toolCall);
    }
    if (toolCall.tool === AIRLOCK_AWAIT_APPROVAL_TOOL) {
      return this.awaitApproval(toolCall);
    }
    return { success: false, error: `Unknown Airlock tool: ${toolCall.tool}` };
  }

  async stop(): Promise<void> {}

  private async askUser(toolCall: ToolCall): Promise<ToolResult> {
    const { hitlEngine, hitlBatcher } = this.deps;
    if (!hitlEngine || !hitlBatcher) {
      return { success: false, error: 'airlock/ask_user requires the Airlock HITL runtime' };
    }

    const question = toolCall.args.question;
    if (typeof question !== 'string' || !question.trim()) {
      return { success: false, error: 'airlock/ask_user requires a non-empty question' };
    }
    const context = typeof toolCall.args.context === 'string' ? toolCall.args.context.trim() : '';
    const args = {
      question: question.trim(),
      ...(context ? { context } : {}),
    };

    const ticket = hitlEngine.create({
      agentId: toolCall.agentId,
      tool: AIRLOCK_ASK_USER_TOOL,
      args,
      kind: 'question',
    });
    hitlBatcher.add({
      ...hitlEngine.buildNotification(ticket.id),
      id: ticket.id,
      code: ticket.code,
      agentId: toolCall.agentId,
      tool: AIRLOCK_ASK_USER_TOOL,
      args,
      timeoutMs: hitlEngine.timeoutMs,
    });

    const result = await ticket.result;
    return {
      success: true,
      data: {
        status: result,
        approved: result === 'approved',
      },
    };
  }

  private async requestApproval(toolCall: ToolCall): Promise<ToolResult> {
    const { hitlEngine, hitlBatcher } = this.deps;
    if (!hitlEngine || !hitlBatcher) {
      return { success: false, error: `${toolCall.tool} requires the Airlock HITL runtime` };
    }
    const reason = optionalStringArg(toolCall.args.reason);
    if (!reason) return { success: false, error: `${toolCall.tool} requires a reason` };
    const calls = toolCall.args.calls;
    if (!Array.isArray(calls) || calls.length === 0) {
      return { success: false, error: `${toolCall.tool} requires a non-empty calls array` };
    }
    if (calls.length > MAX_PLAN_CALLS) {
      return { success: false, error: `At most ${MAX_PLAN_CALLS} calls per approval request` };
    }

    const visible = this.deps.getAgentTools?.(toolCall.agentId) ?? [];
    const plan: PlanEntry[] = [];
    const notRequired: string[] = [];
    for (const [index, call] of calls.entries()) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) {
        return { success: false, error: `calls[${index}] must be an object` };
      }
      const { tool, arguments: rawArgs } = call as { tool?: unknown; arguments?: unknown };
      if (typeof tool !== 'string' || !tool.trim()) {
        return { success: false, error: `calls[${index}].tool must be a tool name` };
      }
      if (
        rawArgs !== undefined &&
        (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))
      ) {
        return { success: false, error: `calls[${index}].arguments must be an object` };
      }
      const entry = visible.find(
        (candidate) =>
          candidate.tool.name === tool || sanitizeToolName(candidate.tool.name) === tool
      );
      if (!entry || isAirlockTool(entry.tool.name)) {
        return { success: false, error: `calls[${index}]: tool not available: ${tool}` };
      }
      if (entry.decision === 'allow') {
        notRequired.push(entry.tool.name);
        continue;
      }
      // Fingerprint exactly what the gate will see: args with the _airlock context stripped.
      const args = extractAirlockContext(
        (rawArgs as Record<string, unknown> | undefined) ?? {}
      ).args;
      plan.push({
        tool: entry.tool.name,
        fingerprint: fingerprintCall(entry.tool.name, args),
        args: hitlEngine.redact(args),
      });
    }

    if (plan.length === 0) {
      return {
        success: true,
        data: {
          status: 'not_required',
          message: 'None of these calls needs approval. Make them directly.',
          notRequired,
        },
      };
    }

    const mode =
      this.deps.getAgentConfig?.(toolCall.agentId)?.approval_mode ?? hitlEngine.defaultMode;
    const ticket = hitlEngine.create({
      agentId: toolCall.agentId,
      tool: AIRLOCK_REQUEST_APPROVAL_TOOL,
      args: { reason, calls: plan.map(({ tool, args }) => ({ tool, args })) },
      context: { reason },
      kind: 'plan',
      mode,
      plan,
    });
    const notification = hitlEngine.buildNotification(ticket.id);
    if (notification) hitlBatcher.add(notification);

    if (mode === 'async') {
      return {
        success: true,
        data: {
          status: 'pending',
          id: ticket.id,
          code: ticket.code,
          message: `Approval requested for ${plan.length} call(s). Call ${sanitizeToolName(AIRLOCK_AWAIT_APPROVAL_TOOL)} with this id to wait for the decision.`,
          ...(notRequired.length > 0 ? { notRequired } : {}),
        },
      };
    }

    const result = await ticket.result;
    return {
      success: true,
      data: {
        status: result,
        approved: result === 'approved',
        id: ticket.id,
        calls: plan.length,
        message: awaitMessage('plan', result),
        ...(notRequired.length > 0 ? { notRequired } : {}),
      },
    };
  }

  private async awaitApproval(toolCall: ToolCall): Promise<ToolResult> {
    const { hitlEngine } = this.deps;
    if (!hitlEngine) {
      return { success: false, error: `${toolCall.tool} requires the Airlock HITL runtime` };
    }
    const id = optionalStringArg(toolCall.args.id);
    if (!id) return { success: false, error: `${toolCall.tool} requires an approval id` };
    const requested =
      typeof toolCall.args.wait_seconds === 'number'
        ? toolCall.args.wait_seconds
        : DEFAULT_AWAIT_SECONDS;
    const waitMs = Math.max(0, Math.min(requested, MAX_AWAIT_SECONDS)) * 1000;

    const status = await hitlEngine.waitFor(id, toolCall.agentId, waitMs);
    if (!status) return { success: false, error: `Unknown approval id: ${id}` };
    return {
      success: true,
      data: {
        id: status.id,
        tool: status.tool,
        status: status.status,
        message: awaitMessage(status.kind, status.status),
      },
    };
  }

  private activity(toolCall: ToolCall, kind: 'notification' | 'log'): ToolResult {
    const title = toolCall.args.title;
    const body = toolCall.args.body;
    if (typeof title !== 'string' || !title.trim()) {
      return { success: false, error: `${toolCall.tool} requires a non-empty title` };
    }
    if (typeof body !== 'string' || !body.trim()) {
      return { success: false, error: `${toolCall.tool} requires a non-empty body` };
    }

    const severity =
      typeof toolCall.args.severity === 'string' &&
      ['info', 'success', 'warning', 'error'].includes(toolCall.args.severity)
        ? (toolCall.args.severity as AirlockActivitySeverity)
        : 'info';

    const event = this.deps.activityStream?.emit({
      kind,
      agentId: toolCall.agentId,
      title: title.trim(),
      body: body.trim(),
      severity,
    });

    return {
      success: true,
      data: {
        ok: true,
        kind,
        ...(event ? { id: event.id, createdAt: event.createdAt } : {}),
      },
    };
  }

  private status(toolCall: ToolCall): ToolResult {
    const requestedProvider = optionalStringArg(toolCall.args.provider);
    const providers = this.providerBuckets(toolCall.agentId, {
      provider: requestedProvider,
      includeTools: false,
      includeSchema: false,
    }).map((provider) => ({
      id: provider.id,
      status: provider.status.status,
      ...(provider.status.reason ? { reason: provider.status.reason } : {}),
      toolCounts: provider.toolCounts,
    }));

    const grants = this.deps.hitlEngine?.listGrants(toolCall.agentId) ?? [];
    return {
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        agentId: toolCall.agentId,
        providers,
        summary: summarizeProviders(providers),
        ...(grants.length > 0
          ? {
              approvalGrants: grants.map((grant) => ({
                covers: grant.label ?? grant.scope.kind,
                ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
                ...(grant.usesRemaining !== undefined
                  ? { usesRemaining: grant.usesRemaining }
                  : {}),
              })),
            }
          : {}),
      },
    };
  }

  private listProviderTools(toolCall: ToolCall): ToolResult {
    const requestedProvider = optionalStringArg(toolCall.args.provider);
    const includeSchema = toolCall.args.include_schema === true;
    const providers = this.providerBuckets(toolCall.agentId, {
      provider: requestedProvider,
      includeTools: true,
      includeSchema,
    }).map((provider) => ({
      id: provider.id,
      status: provider.status.status,
      ...(provider.status.reason ? { reason: provider.status.reason } : {}),
      toolCounts: provider.toolCounts,
      tools: provider.tools,
    }));

    return {
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        agentId: toolCall.agentId,
        providers,
        summary: summarizeProviders(providers),
      },
    };
  }

  private providerBuckets(
    agentId: string,
    opts: { provider?: string; includeTools: boolean; includeSchema: boolean }
  ): ProviderBucket[] {
    const visibleTools = this.deps.getAgentTools?.(agentId) ?? [];
    const providerIds = visibleProviderIds({
      visibleTools,
      agentConfig: this.deps.getAgentConfig?.(agentId),
      knownProviderIds: this.deps.getKnownProviderIds?.() ?? [],
    });

    const requestedProvider = opts.provider?.trim();
    const selectedProviderIds = requestedProvider
      ? providerIds.filter((providerId) => providerId === requestedProvider)
      : providerIds;

    const buckets = new Map<string, ProviderBucket>();
    for (const providerId of selectedProviderIds) {
      buckets.set(providerId, {
        id: providerId,
        status: this.deps.getProviderConnectionStatus?.(providerId) ?? { status: 'up' },
        toolCounts: { allow: 0, ask: 0, total: 0 },
        tools: { allow: [], ask: [] },
      });
    }

    for (const entry of visibleTools) {
      const providerId = entry.providerId;
      const bucket = buckets.get(providerId);
      if (!bucket) continue;

      bucket.toolCounts[entry.decision] += 1;
      bucket.toolCounts.total += 1;
      if (opts.includeTools) {
        bucket.tools[entry.decision].push(toolSummary(entry, opts.includeSchema));
      }
    }

    return Array.from(buckets.values()).sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** MCP-safe tool name, matching the agent server's sanitization ("provider/tool" → "provider_tool"). */
function sanitizeToolName(name: string): string {
  return name.replace(/\//g, '_');
}

function awaitMessage(kind: string, status: string): string {
  switch (status) {
    case 'pending':
      return 'Still waiting for the user. Call again to keep waiting, or continue with other work.';
    case 'approved':
      if (kind === 'plan') {
        return 'Approved. Make each listed call now with exactly the same arguments; they will not prompt again.';
      }
      if (kind === 'question') return 'The user answered yes.';
      return 'Approved. Retry the original call now with identical arguments.';
    case 'denied':
      return 'Denied by the user. Do not retry; ask the user how to proceed.';
    case 'timeout':
      return 'The approval expired without a decision.';
    default:
      return 'The approval was cancelled.';
  }
}

function activityInputSchema(bodyDescription: string): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short human-facing title.' },
      body: { type: 'string', description: bodyDescription },
      severity: {
        type: 'string',
        enum: ['info', 'success', 'warning', 'error'],
        description: 'Optional severity used by Airlock clients when rendering the event.',
      },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  };
}

function optionalProviderInputSchema(): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      provider: {
        type: 'string',
        description: 'Optional provider id to inspect, such as "github" or "filesystem".',
      },
    },
    additionalProperties: false,
  };
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function visibleProviderIds(opts: {
  visibleTools: AgentVisibleTool[];
  agentConfig?: AgentConfig;
  knownProviderIds: string[];
}): string[] {
  const providerIds = new Set(opts.visibleTools.map((entry) => entry.providerId));
  const agentConfig = opts.agentConfig;
  if (!agentConfig) return Array.from(providerIds).sort();

  const positivePatterns = [
    ...agentConfig.allow,
    ...agentConfig.ask,
    ...(agentConfig.remember_allow ?? [])
      .filter((rule) => !rule.expires_at || Date.parse(rule.expires_at) > Date.now())
      .map((rule) => rule.tool),
  ];

  for (const providerId of opts.knownProviderIds) {
    if (providerIds.has(providerId)) continue;
    if (
      positivePatterns.some((pattern) =>
        patternExposesProvider(pattern, providerId, agentConfig.deny)
      )
    ) {
      providerIds.add(providerId);
    }
  }

  return Array.from(providerIds).sort();
}

function patternMentionsProvider(pattern: string, providerId: string): boolean {
  return (
    pattern === '*' ||
    pattern.startsWith(`${providerId}/`) ||
    matches(pattern, `${providerId}/__airlock_status_probe__`)
  );
}

function patternExposesProvider(
  pattern: string,
  providerId: string,
  denyPatterns: string[]
): boolean {
  if (!patternMentionsProvider(pattern, providerId)) return false;

  const representativeTool =
    pattern.startsWith(`${providerId}/`) && !pattern.includes('*')
      ? pattern
      : `${providerId}/__airlock_status_probe__`;
  const positiveSpec = specificity(pattern, representativeTool);
  if (positiveSpec < 0) return false;

  return positiveSpec > bestSpecificity(denyPatterns, representativeTool);
}

function toolSummary(entry: AgentVisibleTool, includeSchema: boolean): Record<string, unknown> {
  return {
    name: entry.tool.name,
    ...(entry.resolvedName !== entry.tool.name ? { resolvedName: entry.resolvedName } : {}),
    ...(entry.tool.description ? { description: entry.tool.description } : {}),
    ...(includeSchema ? { inputSchema: entry.tool.inputSchema } : {}),
  };
}

function summarizeProviders(
  providers: Array<{ status: ProviderConnectionStatus['status']; toolCounts: ToolCounts }>
): {
  providers: Record<ProviderConnectionStatus['status'], number>;
  tools: ToolCounts;
} {
  const summary = {
    providers: { up: 0, connecting: 0, down: 0, auth_required: 0 },
    tools: { allow: 0, ask: 0, total: 0 },
  };
  for (const provider of providers) {
    summary.providers[provider.status] += 1;
    summary.tools.allow += provider.toolCounts.allow;
    summary.tools.ask += provider.toolCounts.ask;
    summary.tools.total += provider.toolCounts.total;
  }
  return summary;
}
