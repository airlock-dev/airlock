import { randomUUID } from 'crypto';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentServerDeps } from './agent-server.js';
import { createStatelessAgentServer } from './stateless-agent-server.js';
import { childLogger } from '../util/logger.js';
import {
  checkBearerAuth,
  checkOrigin,
  currentRequestSecurity,
  type RequestSecurityOptions,
} from '../security/request.js';

const log = childLogger('stateless-http-server');

interface ProfileHandler {
  mcp: McpHttpHandler;
  node: NodeMcpRequestHandler;
}

interface StatelessHttpOptions {
  getDeps: (agentId: string) => AgentServerDeps | undefined;
  secret?: string;
  authRequired?: boolean;
  allowedOrigins?: string[];
  getRequestSecurity?: () => RequestSecurityOptions;
}

/** Shared per-request edge for modern MCP and legacy requests without a session. */
export function createStatelessHttpHandler(opts: StatelessHttpOptions): {
  handle: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  close: () => Promise<void>;
} {
  const handlers = new Map<string, ProfileHandler>();

  function checkAgentAuth(
    request: FastifyRequest,
    reply: FastifyReply,
    deps: AgentServerDeps
  ): boolean {
    const requestSecurity = currentRequestSecurity(opts);
    if (!checkOrigin(request, reply, requestSecurity.allowedOrigins)) return false;

    const token = deps.agentConfig.token;
    if (token) {
      return checkBearerAuth(request, reply, { secret: token, authRequired: true });
    }
    return checkBearerAuth(request, reply, {
      secret: requestSecurity.secret,
      authRequired: requestSecurity.authRequired,
    });
  }

  function handlerFor(profileId: string): ProfileHandler {
    const existing = handlers.get(profileId);
    if (existing) return existing;

    const mcp = createMcpHandler(
      ({ requestInfo }) => {
        const deps = opts.getDeps(profileId);
        if (!deps) throw new Error(`Unknown agent profile: ${profileId}`);
        return createStatelessAgentServer({
          ...deps,
          // A sessionless request must never inherit another caller's session-only approval.
          downstreamSessionId: randomUUID(),
          signal: requestInfo?.signal,
        });
      },
      {
        // One endpoint supports modern MCP and older Streamable HTTP clients, but both are
        // deliberately stateless. This is the compatibility bridge off sessionful v1.
        legacy: 'stateless',
        onerror: (err) => log.error({ profileId, err }, 'Stateless MCP handler error'),
      }
    );
    const profileHandler: ProfileHandler = {
      mcp,
      node: toNodeHandler(mcp, {
        onerror: (err) => log.error({ profileId, err }, 'Stateless MCP Node adapter error'),
      }),
    };
    handlers.set(profileId, profileHandler);
    return profileHandler;
  }

  async function handleMcpRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { profileId } = request.params as { profileId: string };
    const deps = opts.getDeps(profileId);
    if (!deps) {
      return reply.status(404).send({ error: `Unknown agent profile: ${profileId}` });
    }
    if (!checkAgentAuth(request, reply, deps)) return;

    const reqId = randomUUID().slice(0, 8);
    const startedAt = Date.now();
    log.info({ profileId, reqId, httpMethod: request.method }, 'Stateless MCP request in');

    reply.hijack();
    try {
      await handlerFor(profileId).node(request.raw, reply.raw, request.body);
    } finally {
      log.info(
        {
          profileId,
          reqId,
          httpMethod: request.method,
          protocolVersion: request.headers['mcp-protocol-version'],
          statusCode: reply.raw.statusCode,
          ms: Date.now() - startedAt,
        },
        'Stateless MCP request done'
      );
    }
  }

  return {
    handle: handleMcpRequest,
    close: async () => {
      await Promise.allSettled([...handlers.values()].map(({ mcp }) => mcp.close()));
      handlers.clear();
    },
  };
}

/** Explicit stateless mode: modern MCP and the SDK's legacy-stateless fallback. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function statelessHttpServerPlugin(
  app: FastifyInstance,
  opts: StatelessHttpOptions
): Promise<void> {
  const handler = createStatelessHttpHandler(opts);
  // The adapter consumes the raw request stream in explicit stateless mode.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    (_req: FastifyRequest, _payload: unknown, done: (err: null) => void) => done(null)
  );
  app.post('/agents/:profileId/mcp', handler.handle);
  app.get('/agents/:profileId/mcp', handler.handle);
  app.delete('/agents/:profileId/mcp', handler.handle);
  app.addHook('onClose', handler.close);
}
