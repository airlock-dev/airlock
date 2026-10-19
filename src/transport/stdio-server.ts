import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createAgentServer } from './agent-server.js';
import type { AgentServerDeps } from './agent-server.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('stdio-server');

/**
 * Serve one agent over stdio. `serveStdio` picks the protocol era from the client's opening message
 * (a 2026-07-28 `server/discover`, or a 2025-era `initialize`) and pins one server instance from the
 * factory for the connection. A stdio process is one agent session, so `deps.downstreamSessionId`
 * (minted per process) already scopes session grants correctly.
 */
export async function runStdioServer(deps: AgentServerDeps): Promise<void> {
  log.info({ agentId: deps.agentId }, 'Starting stdio server');
  const closed = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  const handle = serveStdio(() => createAgentServer(deps), {
    onerror: (err) => log.warn({ agentId: deps.agentId, err }, 'stdio MCP error'),
  });
  log.info({ agentId: deps.agentId }, 'Stdio server connected');
  try {
    await closed;
  } finally {
    await handle.close();
  }
}
