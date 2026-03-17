import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from '../backend/types.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { AgentConfig } from '../config/schema.js';
import { sanitizeToolDescription } from './sanitizer.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('registry');

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
    const agent = this.agents[agentId];
    const overrides = agent?.tool_overrides ?? {};

    const filtered = this.cachedTools
      .filter((t) => this.allowlist.evaluate(agentId, t.name) !== 'deny')
      .map((t) => ({
        ...t,
        description: sanitizeToolDescription(t.name, t.description, overrides[t.name]?.description),
      }));

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
      if (this.allowlist.evaluate(agentId, aliasName) === 'deny') continue;

      filtered.push({
        ...baseTool,
        name: aliasName,
        description: sanitizeToolDescription(aliasName, baseTool.description, override.description),
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
    // Resolve alias: if the tool name is an alias, map it to the real backend tool
    let resolvedName = namespacedName;
    const agent = this.agents[agentId];
    const override = agent?.tool_overrides?.[namespacedName];
    if (override?.alias_of) {
      resolvedName = override.alias_of;
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

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.adapters.map((a) => a.stop()));
  }
}

/** Map adapter ID conventions to the tool name prefix they own. */
function getAdapterPrefix(adapter: BackendAdapter): string | null {
  const id = adapter.id;
  if (id.startsWith('mcp:')) return id.slice(4) + '/';
  if (id === 'builtin:exec') return 'exec/';
  if (id === 'builtin:http') return 'http/';
  if (id.startsWith('cli:')) return id.slice(4) + '/';
  if (id.startsWith('api:')) return id.slice(4) + '/';
  return null;
}
