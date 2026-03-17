import type { Middleware } from '../types.js';
import { resolveSandboxConfig } from '../../sandbox/index.js';

export function sandboxMiddleware(): Middleware {
  return async (ctx, next) => {
    const agentSandbox = ctx.agentConfig?.sandbox;

    if (agentSandbox?.enabled) {
      // Check if there's a tool-specific sandbox from tool_overrides (alias)
      const toolOverride = ctx.agentConfig?.tool_overrides?.[ctx.toolName];
      const toolOverrideSandbox = toolOverride?.sandbox;

      ctx.meta.sandbox = resolveSandboxConfig(agentSandbox, ctx.toolName, toolOverrideSandbox);
    }

    return next();
  };
}
