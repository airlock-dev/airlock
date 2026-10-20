import { McpServer, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/server';
import type { AgentServerDeps } from './agent-server.js';
import { createAgentToolHandlers } from './agent-server.js';
import { childLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

const log = childLogger('stateless-agent-server');

/**
 * Build one short-lived MCP server for a single HTTP exchange.
 *
 * The v2 SDK's HTTP handler creates a fresh instance per request. No session identifier or
 * initialization state survives at this edge, so an Airlock restart cannot strand a client on a
 * session that only existed in the old process.
 */
export function createStatelessAgentServer(deps: AgentServerDeps): McpServer {
  let instructions: string | undefined;
  try {
    instructions = deps.registry.getInstructionsFor(deps.agentId);
  } catch (err) {
    log.debug({ agentId: deps.agentId, err }, 'Failed to build server instructions');
  }

  const server = new McpServer(
    { name: 'airlock', version: VERSION },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) }
  );
  const handlers = createAgentToolHandlers(deps);

  // The internal registry is still typed against SDK v1 while the edge is SDK v2. Both values are
  // the same MCP wire contracts; keep the cast at this one migration boundary instead of leaking
  // dual-SDK types through the policy pipeline.
  server.server.setRequestHandler(
    'tools/list',
    () => handlers.listTools() as unknown as ListToolsResult
  );
  server.server.setRequestHandler(
    'tools/call',
    async (request, context) =>
      (await handlers.callTool(request.params, context.mcpReq.signal)) as unknown as CallToolResult
  );

  return server;
}
