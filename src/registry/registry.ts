import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ClientPool } from '../pool/pool.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import { sanitizeToolDescription } from './sanitizer.js';
import { buildHttpTools, executeHttp } from '../tools/http.js';
import { buildExecTool } from '../tools/exec.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('registry');

export class ToolRegistry {
  private toolIndex = new Map<string, { mcpId: string; originalName: string }>();
  private cachedTools: Tool[] = [];
  private builtinTools: Tool[] = [];

  constructor(
    private pool: ClientPool,
    private allowlist: AllowlistEngine,
    private agents: Record<string, AgentConfig>,
    private security: SecurityConfig,
  ) {
    this.builtinTools = [...buildHttpTools(), buildExecTool()];
  }

  async refresh(): Promise<void> {
    const tools: Tool[] = [];

    for (const mcpId of this.pool.getMcpIds()) {
      try {
        const mcpTools = await this.pool.listTools(mcpId);
        for (const tool of mcpTools) {
          const namespacedName = `${mcpId}/${tool.name}`;
          this.toolIndex.set(namespacedName, { mcpId, originalName: tool.name });
          tools.push({
            ...tool,
            name: namespacedName,
            description: sanitizeToolDescription(namespacedName, tool.description),
          });
        }
      } catch (err) {
        log.warn({ err, mcpId }, 'Failed to list tools from MCP');
      }
    }

    // Register builtins
    for (const tool of this.builtinTools) {
      tools.push(tool);
    }

    this.cachedTools = tools;
    log.info({ count: tools.length }, 'Tool registry refreshed');
  }

  getFiltered(agentId: string): Tool[] {
    const agent = this.agents[agentId];
    const overrides = agent?.tool_overrides ?? {};

    return this.cachedTools
      .filter(t => this.allowlist.evaluate(agentId, t.name) !== 'deny')
      .map(t => ({
        ...t,
        description: sanitizeToolDescription(
          t.name,
          t.description,
          overrides[t.name]?.description,
        ),
      }));
  }

  async call(
    namespacedName: string,
    args: Record<string, unknown>,
    agentId: string,
  ): Promise<unknown> {
    // Built-in HTTP tools
    const httpMatch = namespacedName.match(/^http\/(get|post|put|patch|delete|head)$/);
    if (httpMatch) {
      const method = httpMatch[1] as 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
      const agent = this.agents[agentId];
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      return executeHttp(method, args, agent, this.security);
    }

    // Built-in exec tool — caller handles exec logic before calling here
    if (namespacedName === 'exec/run') {
      throw new Error('exec/run must be handled by the gateway pipeline, not called directly');
    }

    // Downstream MCP tools
    const entry = this.toolIndex.get(namespacedName);
    if (!entry) throw new Error(`Unknown tool: ${namespacedName}`);

    return this.pool.callTool(entry.mcpId, entry.originalName, args);
  }

  getAllTools(): Tool[] {
    return this.cachedTools;
  }
}
