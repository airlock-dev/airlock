import type { ToolRegistry } from '../registry/registry.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentConfig, SecurityConfig } from '../config/schema.js';

export interface ToolCallContext {
  callId: string;
  agentId: string;
  agentConfig: AgentConfig;
  toolName: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown>;
  deps: MiddlewareDeps;
  startedAt: number;
  /** Signals that the transport/session has been closed. */
  signal?: AbortSignal;
  /** Sends an MCP progress notification, when the client asked for progress on this call. */
  sendProgress?: (progress: number, message: string) => void;
  /**
   * Run this same call again through the agent's full pipeline, in a fresh context detached from
   * the original request (no signal, no progress). `prepare` sees the fresh context before it runs.
   * Used to execute a call the moment it is approved after the agent was answered "pending".
   */
  reenter?: (prepare: (fresh: ToolCallContext) => void) => Promise<ToolCallResponse>;
}

export interface ToolCallResponse {
  result: unknown;
  text: string;
  truncated?: boolean;
  fullOutputPath?: string;
}

export type Middleware = (
  ctx: ToolCallContext,
  next: () => Promise<ToolCallResponse>
) => Promise<ToolCallResponse>;

export interface MiddlewareDeps {
  registry: ToolRegistry;
  allowlist: AllowlistEngine;
  hitlEngine: HitlEngine;
  hitlBatcher: HitlBatcher;
  auditLogger: AuditLogger;
  securityConfig: SecurityConfig;
}
