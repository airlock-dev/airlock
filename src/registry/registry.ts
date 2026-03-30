import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from '../backend/types.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { AgentConfig, ProfileConfig } from '../config/schema.js';
import { matches } from '../allowlist/pattern.js';
import { sanitizeToolDescription } from './sanitizer.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('registry');

export class ToolRegistry {
  private cachedTools: Tool[] = [];

  constructor(
    private adapters: BackendAdapter[],
    private allowlist: AllowlistEngine,
    private agents: Record<string, AgentConfig>,
    private profiles: Record<string, ProfileConfig> = {}
  ) {}

  reloadAgents(agents: Record<string, AgentConfig>): void {
    this.agents = agents;
  }

  reloadProfiles(profiles: Record<string, ProfileConfig>): void {
    this.profiles = profiles;
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
    this.detectDrift();
  }

  /** Compare live tools against config references and log drift warnings. */
  private detectDrift(): void {
    const toolNames = new Set(this.cachedTools.map((t) => t.name));

    // Collect all exact tool references (no wildcards) from agents and profiles
    const exactRefs = new Map<string, string[]>(); // toolName → ["agent:foo", "profile:bar"]

    for (const [agentId, agent] of Object.entries(this.agents)) {
      for (const pattern of [...agent.allow, ...agent.ask, ...agent.deny]) {
        if (!pattern.includes('*') && pattern.includes('/')) {
          const sources = exactRefs.get(pattern) ?? [];
          sources.push(`agent:${agentId}`);
          exactRefs.set(pattern, sources);
        }
      }
    }

    for (const [profileId, profile] of Object.entries(this.profiles)) {
      for (const pattern of [...profile.allow, ...profile.ask]) {
        if (!pattern.includes('*') && pattern.includes('/')) {
          const sources = exactRefs.get(pattern) ?? [];
          sources.push(`profile:${profileId}`);
          exactRefs.set(pattern, sources);
        }
      }
    }

    // Warn about stale references — exact tool names that no longer exist
    for (const [ref, sources] of exactRefs) {
      if (!toolNames.has(ref)) {
        log.warn(
          { tool: ref, referencedBy: sources },
          `Config references tool "${ref}" which no longer exists in any provider`
        );
      }
    }

    // Collect all patterns from agents and profiles
    const allPatterns: string[] = [];
    for (const agent of Object.values(this.agents)) {
      allPatterns.push(...agent.allow, ...agent.ask, ...agent.deny);
    }
    for (const profile of Object.values(this.profiles)) {
      allPatterns.push(...profile.allow, ...profile.ask);
    }

    // Info about uncovered tools — tools no pattern matches
    for (const toolName of toolNames) {
      const covered = allPatterns.some((p) => matches(p, toolName));
      if (!covered) {
        log.info(
          { tool: toolName },
          `Tool "${toolName}" is not referenced by any agent or profile`
        );
      }
    }
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
