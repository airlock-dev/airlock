import type { AgentConfig } from '../config/schema.js';
import type { Middleware, ToolCallContext, ToolCallResponse } from './types.js';
import { buildMiddlewareChain } from './chain-builder.js';

function terminal(): Promise<ToolCallResponse> {
  throw new Error('Middleware chain did not terminate — missing execute middleware');
}

/**
 * Let a call re-enter the agent's full pipeline later (see ToolCallContext.reenter). Call before
 * the chain runs: the fresh context starts from the call's original args and meta, picks up the
 * agent's live config, and keeps the call id so the audit trail of the eventual run joins the
 * original request. Raw args stay in this closure, in memory only.
 */
export function attachReentry(
  ctx: ToolCallContext,
  opts: { getAgentConfig: () => AgentConfig; chain?: Middleware }
): void {
  const args = ctx.args;
  const meta = { ...ctx.meta };
  ctx.reenter = (prepare) => {
    const agentConfig = opts.getAgentConfig();
    const fresh: ToolCallContext = {
      callId: ctx.callId,
      agentId: ctx.agentId,
      agentConfig,
      toolName: ctx.toolName,
      args,
      meta: { ...meta },
      deps: ctx.deps,
      startedAt: Date.now(),
    };
    prepare(fresh);
    const chain = opts.chain ?? buildMiddlewareChain(agentConfig);
    return chain(fresh, terminal);
  };
}
