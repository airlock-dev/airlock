import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentServer, connectAgentServer } from './agent-server.js';
import type { AgentServerDeps } from './agent-server.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('stdio-server');

export async function runStdioServer(deps: AgentServerDeps): Promise<void> {
  log.info({ agentId: deps.agentId }, 'Starting stdio server');
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  const server = createAgentServer(deps);
  await connectAgentServer(server, transport);
  log.info({ agentId: deps.agentId }, 'Stdio server connected');
  await closed;
}
