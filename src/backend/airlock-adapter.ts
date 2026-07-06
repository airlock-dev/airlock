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
  AIRLOCK_LIST_PROVIDER_TOOLS_TOOL,
  AIRLOCK_LOG_TOOL,
  AIRLOCK_NOTIFY_USER_TOOL,
  AIRLOCK_STATUS_TOOL,
} from '../airlock/tools.js';
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

  constructor(private deps: AirlockBackendDeps = {}) {}

  listTools(): Promise<Tool[]> {
    return Promise.resolve([
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
    ]);
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
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
    });
    hitlBatcher.add({
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
