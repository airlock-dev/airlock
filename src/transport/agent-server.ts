import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolRegistry } from '../registry/registry.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { HitlProvider } from '../hitl/providers/types.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentConfig } from '../config/schema.js';
import { executeExec, evaluateExecCommand } from '../tools/exec.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('agent-server');

export interface AgentServerDeps {
  agentId: string;
  agentConfig: AgentConfig;
  registry: ToolRegistry;
  allowlist: AllowlistEngine;
  hitlEngine: HitlEngine;
  hitlBatcher: HitlBatcher;
  hitlProvider: HitlProvider;
  auditLogger: AuditLogger;
}

export function createAgentServer(deps: AgentServerDeps): Server {
  const {
    agentId, agentConfig, registry, allowlist,
    hitlEngine, hitlBatcher, hitlProvider, auditLogger,
  } = deps;

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
    const start = Date.now();

    // 1. Allowlist check
    const decision = allowlist.evaluate(agentId, toolName);
    if (decision === 'deny') {
      log.info({ agentId, toolName }, 'Tool call denied by allowlist');
      auditLogger.log({ agent_id: agentId, tool: toolName, args: JSON.stringify(args), result: 'denied' });
      throw new McpError(ErrorCode.InvalidRequest, `Tool not available: ${toolName}`);
    }

    // 2. Exec-specific command policy
    let needsHitl = decision === 'hitl';

    if (toolName === 'exec/run') {
      const command = args['command'] as string | undefined;
      if (!command) throw new McpError(ErrorCode.InvalidParams, 'exec/run requires a command');

      const cmdDecision = evaluateExecCommand(command, agentConfig);
      if (cmdDecision === 'deny') {
        log.info({ agentId, command }, 'exec command denied by policy');
        auditLogger.log({ agent_id: agentId, tool: toolName, args: JSON.stringify(args), result: 'denied' });
        throw new McpError(ErrorCode.InvalidRequest, `Command denied by policy: ${command}`);
      }
      if (cmdDecision === 'hitl') needsHitl = true;
    }

    // 3. HITL gate
    if (needsHitl) {
      let notifyArgs = args;
      // Queue into batcher — for now we do immediate single-request flow
      const hitlPromise = hitlEngine.request({ agentId, tool: toolName, args });

      // Notify via batcher
      hitlBatcher.add({
        id: 'pending', // engine has already registered
        code: 'pending',
        agentId,
        tool: toolName,
        args,
        timeoutMs: 300000,
      });

      const result = await hitlPromise;

      if (result === 'denied') {
        auditLogger.log({ agent_id: agentId, tool: toolName, args: JSON.stringify(args), result: 'hitl_denied' });
        throw new McpError(ErrorCode.InvalidRequest, `Request denied by operator`);
      }
      if (result === 'timeout') {
        auditLogger.log({ agent_id: agentId, tool: toolName, args: JSON.stringify(args), result: 'hitl_timeout' });
        throw new McpError(ErrorCode.InvalidRequest, `Approval timed out. Re-request when operator is available.`);
      }
    }

    // 4. Execute
    try {
      let callResult: unknown;

      if (toolName === 'exec/run') {
        const command = args['command'] as string;
        const cwd = args['cwd'] as string | undefined;
        const timeoutMs = args['timeout_ms'] as number | undefined;
        callResult = await executeExec(command, agentConfig, cwd, timeoutMs);
      } else {
        callResult = await registry.call(toolName, args, agentId);
      }

      const duration = Date.now() - start;
      auditLogger.log({
        agent_id: agentId, tool: toolName,
        args: JSON.stringify(args), result: 'success', duration_ms: duration,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(callResult) }],
      };
    } catch (err) {
      const duration = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      auditLogger.log({
        agent_id: agentId, tool: toolName,
        args: JSON.stringify(args), result: 'error', error, duration_ms: duration,
      });
      throw new McpError(ErrorCode.InternalError, error);
    }
  });

  return server;
}

export async function connectAgentServer(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}
