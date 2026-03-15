import type { BackendAdapter } from './types.js';
import type { Config } from '../config/loader.js';
import type { ClientPool } from '../pool/pool.js';
import { McpBackendAdapter } from './mcp-adapter.js';
import { ExecBackendAdapter } from './exec-adapter.js';
import { HttpBackendAdapter } from './http-adapter.js';
import { CliBackendAdapter } from './cli/adapter.js';
import { OpenApiAdapter } from './openapi/adapter.js';
import { getBuiltinProviders } from '../config/schema.js';

/**
 * Build all BackendAdapter instances from the gateway config.
 * MCP adapters wrap the existing ClientPool; CLI and API adapters are standalone.
 */
export function buildAdapters(config: Config, pool: ClientPool): BackendAdapter[] {
  const adapters: BackendAdapter[] = [];

  // MCP adapters — one per connected MCP server
  for (const mcpId of pool.getMcpIds()) {
    adapters.push(new McpBackendAdapter(mcpId, pool));
  }

  // Builtin adapters
  const builtins = getBuiltinProviders(config.providers);
  if (builtins.has('exec')) {
    adapters.push(new ExecBackendAdapter(config.agents));
  }
  if (builtins.has('http')) {
    adapters.push(new HttpBackendAdapter(config.agents, config.security));
  }

  // CLI adapters — one per clis.{key} entry
  for (const [key, cliConfig] of Object.entries(config.clis ?? {})) {
    adapters.push(new CliBackendAdapter(key, cliConfig));
  }

  // OpenAPI adapters — one per apis.{key} entry
  for (const [key, apiConfig] of Object.entries(config.apis ?? {})) {
    adapters.push(new OpenApiAdapter(key, apiConfig, config.security));
  }

  return adapters;
}
