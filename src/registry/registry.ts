import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from '../backend/types.js';
import type { AllowlistEngine, Decision } from '../allowlist/engine.js';
import type { AgentConfig } from '../config/schema.js';
import { sanitizeToolDescription } from './sanitizer.js';
import { addAskPolicyGuidance } from './airlock-policy.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('registry');

export interface AgentVisibleTool {
  tool: Tool;
  decision: Exclude<Decision, 'deny'>;
  providerId: string;
  resolvedName: string;
}

export class ToolRegistry {
  private cachedTools: Tool[] = [];

  constructor(
    private adapters: BackendAdapter[],
    private allowlist: AllowlistEngine,
    private agents: Record<string, AgentConfig>
  ) {}

  reloadAgents(agents: Record<string, AgentConfig>): void {
    this.agents = agents;
  }

  setAdapters(adapters: BackendAdapter[]): void {
    this.adapters = adapters;
  }

  async refresh(): Promise<void> {
    const tools: Tool[] = [];

    for (const adapter of this.adapters) {
      try {
        const adapterTools = await adapter.listTools();
        for (const tool of adapterTools) {
          tools.push({
            ...tool,
            description: sanitizeToolDescription(tool.name, tool.description),
          });
        }
      } catch (err) {
        log.warn({ err, adapterId: adapter.id }, 'Failed to list tools from adapter');
      }
    }

    this.cachedTools = tools;
    log.info({ count: tools.length }, 'Tool registry refreshed');
  }

  getFiltered(agentId: string): Tool[] {
    return this.getFilteredWithDecisions(agentId).map((entry) => entry.tool);
  }

  getFilteredWithDecisions(agentId: string): AgentVisibleTool[] {
    const agent = this.agents[agentId];
    const overrides = agent?.tool_overrides ?? {};

    const filtered = this.cachedTools
      .map((t): AgentVisibleTool | undefined => {
        const decision = this.allowlist.evaluate(agentId, t.name);
        if (decision === 'deny') return undefined;
        return {
          tool: this.applyAgentView(agentId, t, overrides[t.name]?.description),
          decision,
          providerId: providerIdForTool(t.name),
          resolvedName: t.name,
        };
      })
      .filter((entry): entry is AgentVisibleTool => Boolean(entry));

    // Add alias tools from tool_overrides that have alias_of
    for (const [aliasName, override] of Object.entries(overrides)) {
      if (!override.alias_of) continue;

      // Find the base tool in the full tool list (not filtered)
      const baseTool = this.cachedTools.find((t) => t.name === override.alias_of);
      if (!baseTool) {
        log.warn({ aliasName, aliasOf: override.alias_of }, 'Alias references unknown tool');
        continue;
      }

      // Check if the alias itself is allowed
      const decision = this.allowlist.evaluate(agentId, aliasName);
      if (decision === 'deny') continue;

      filtered.push({
        tool: this.applyAgentView(agentId, { ...baseTool, name: aliasName }, override.description),
        decision,
        providerId: providerIdForTool(aliasName),
        resolvedName: override.alias_of,
      });
    }

    return filtered;
  }

  async call(
    namespacedName: string,
    args: Record<string, unknown>,
    agentId: string,
    meta?: Record<string, unknown>
  ): Promise<unknown> {
    const resolvedName = this.resolveToolName(namespacedName, agentId);
    if (resolvedName !== namespacedName) {
      log.info({ alias: namespacedName, resolved: resolvedName }, 'Resolved tool alias');
    }

    // Find the adapter that owns this tool by matching its prefix
    for (const adapter of this.adapters) {
      const prefix = getAdapterPrefix(adapter);
      if (prefix && resolvedName.startsWith(prefix)) {
        const result = await adapter.call({ tool: resolvedName, args, agentId, meta });
        if (!result.success) {
          throw new Error(result.error ?? 'Tool call failed');
        }
        return result.data;
      }
    }

    throw new Error(`Unknown tool: ${resolvedName}`);
  }

  getAllTools(): Tool[] {
    return this.cachedTools;
  }

  resolveToolName(namespacedName: string, agentId: string): string {
    const agent = this.agents[agentId];
    return agent?.tool_overrides?.[namespacedName]?.alias_of ?? namespacedName;
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.adapters.map((a) => a.stop()));
  }

  private applyAgentView(agentId: string, tool: Tool, overrideDescription?: string): Tool {
    const decision = this.allowlist.evaluate(agentId, tool.name);
    const sanitized: Tool = {
      ...tool,
      description: sanitizeToolDescription(tool.name, tool.description, overrideDescription),
    };
    return decision === 'ask' ? addAskPolicyGuidance(sanitized) : sanitized;
  }
}

function providerIdForTool(toolName: string): string {
  const separatorIndex = toolName.indexOf('/');
  return separatorIndex > 0 ? toolName.slice(0, separatorIndex) : toolName;
}

/** Map adapter ID conventions to the tool name prefix they own. */
function getAdapterPrefix(adapter: BackendAdapter): string | null {
  const id = adapter.id;
  if (id.startsWith('mcp:')) return id.slice(4) + '/';
  if (id === 'builtin:exec') return 'exec/';
  if (id === 'builtin:http') return 'http/';
  if (id === 'builtin:airlock') return 'airlock/';
  if (id.startsWith('cli:')) return id.slice(4) + '/';
  if (id.startsWith('api:')) return id.slice(4) + '/';
  return null;
}
