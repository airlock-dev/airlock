/**
 * Airlock Bridge — OpenClaw plugin
 *
 * Fetches the tool list from Airlock at startup and registers each one as a
 * native OpenClaw tool. Every tool call is forwarded to Airlock, which applies
 * the agent's allowlist, HITL gate, sandbox, and audit logging before executing.
 *
 * Configuration (plugin config or environment variable fallbacks):
 *   url    / AIRLOCK_URL     Base URL of Airlock's agent data-plane (default: http://localhost:4111)
 *   agent  / AIRLOCK_AGENT   Agent profile to run as           (default: openclaw)
 *   secret / AIRLOCK_SECRET  Bearer token / agent token        (default: empty = no auth)
 *
 * Install:
 *   airlock setup openclaw
 *
 * The setup command creates a symlink:
 *   ~/.openclaw/extensions/airlock-bridge -> extensions/openclaw
 */

import { Type } from '@sinclair/typebox';
import { randomUUID } from 'crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

interface AirlockTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface AirlockInvokeResult {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: { duration_ms: number; truncated: boolean };
}

// Convert an Airlock tool name (e.g. "github/list_prs") to a valid OpenClaw
// tool identifier (e.g. "airlock_github_list_prs").
function toOpenClawName(airlockName: string): string {
  return 'airlock_' + airlockName.replace(/[^a-zA-Z0-9]/g, '_');
}

export default async function register(api: OpenClawPluginApi): Promise<void> {
  const cfg = (api.pluginConfig ?? {}) as { url?: string; agent?: string; secret?: string };

  const baseUrl = (process.env['AIRLOCK_URL'] ?? cfg.url ?? 'http://localhost:4111').replace(
    /\/$/,
    ''
  );
  const agentId = process.env['AIRLOCK_AGENT'] ?? cfg.agent ?? 'openclaw';
  const secret = process.env['AIRLOCK_SECRET'] ?? cfg.secret ?? '';
  const sessionId = randomUUID();

  const authHeaders: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {};

  // Fetch tools and register them once the gateway is ready.
  api.on('gateway_start', async () => {
    let tools: AirlockTool[];

    try {
      const res = await fetch(`${baseUrl}/agents/${agentId}/tools`, {
        headers: authHeaders,
      });

      if (!res.ok) {
        api.logger.error(`[airlock-bridge] Failed to fetch tools: HTTP ${res.status}`);
        return;
      }

      const body = (await res.json()) as { tools: AirlockTool[] };
      tools = body.tools;
    } catch (err) {
      api.logger.error(`[airlock-bridge] Could not reach Airlock gateway: ${String(err)}`);
      return;
    }

    api.logger.info(`[airlock-bridge] Registering ${tools.length} tools for agent "${agentId}"`);

    for (const tool of tools) {
      const openClawName = toOpenClawName(tool.name);
      const airlockName = tool.name; // captured in closure

      api.registerTool(
        {
          name: openClawName,
          label: tool.name, // human-readable: preserves the original "namespace/tool" form
          description: tool.description ?? openClawName,
          // Wrap Airlock's JSON Schema as a typebox Unsafe type so OpenClaw's
          // tool registry accepts it without modification.
          parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),

          async execute(_toolCallId: string, params: Record<string, unknown>) {
            let result: AirlockInvokeResult;

            try {
              const res = await fetch(`${baseUrl}/agents/${agentId}/tools/invoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ tool: airlockName, args: params, session_id: sessionId }),
              });
              result = (await res.json()) as AirlockInvokeResult;
            } catch (err) {
              return {
                content: [{ type: 'text' as const, text: `Airlock unreachable: ${String(err)}` }],
                details: {},
              };
            }

            if (!result.success) {
              return {
                content: [
                  { type: 'text' as const, text: `Error: ${result.error ?? 'unknown error'}` },
                ],
                details: result.metadata ?? {},
              };
            }

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? null) }],
              details: result.metadata ?? {},
            };
          },
        },
        { optional: true }
      );
    }
  });
}
