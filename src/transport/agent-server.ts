import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolRegistry } from '../registry/registry.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { HitlProvider } from '../hitl/providers/types.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';
import type { Middleware, ToolCallContext } from '../middleware/types.js';
import { buildMiddlewareChain } from '../middleware/chain-builder.js';
import { generateId } from '../util/id.js';

export interface AgentServerDeps {
  agentId: string;
  agentConfig: AgentConfig;
  getAgentConfig?: () => AgentConfig;
  registry: ToolRegistry;
  allowlist: AllowlistEngine;
  hitlEngine: HitlEngine;
  hitlBatcher: HitlBatcher;
  hitlProvider: HitlProvider;
  auditLogger: AuditLogger;
  securityConfig?: SecurityConfig;
  chain?: Middleware;
}

export function createAgentServer(deps: AgentServerDeps): Server {
  const {
    agentId, registry, allowlist,
    hitlEngine, hitlBatcher, auditLogger,
  } = deps;
  const getConfig = deps.getAgentConfig ?? (() => deps.agentConfig);

  const chain = deps.chain ?? buildMiddlewareChain(getConfig(), {
    registry, allowlist, hitlEngine, hitlBatcher, auditLogger,
    securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
  });

  const server = new Server(
    { name: 'airlock', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = registry.getFiltered(agentId);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const ctx: ToolCallContext = {
      callId: generateId(),
      agentId,
      agentConfig: getConfig(),
      toolName,
      args,
      meta: {},
      deps: {
        registry, allowlist, hitlEngine, hitlBatcher, auditLogger,
        securityConfig: deps.securityConfig ?? { blocked_hosts: [], allowed_local: [] },
      },
      startedAt: Date.now(),
    };

    const response = await chain(ctx, async () => {
      throw new Error('Middleware chain did not terminate — missing execute middleware');
    });

    return {
      content: [{ type: 'text', text: response.text }],
    };
  });

  return server;
}

export async function connectAgentServer(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}
