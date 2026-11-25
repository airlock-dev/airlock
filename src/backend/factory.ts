import type { BackendAdapter } from './types.js';
import type { Config } from '../config/loader.js';
import type { ClientPool } from '../pool/pool.js';
import { McpBackendAdapter } from './mcp-adapter.js';
import { ExecBackendAdapter } from './exec-adapter.js';
import { HttpBackendAdapter } from './http-adapter.js';
import { AirlockBackendAdapter, type AirlockBackendDeps } from './airlock-adapter.js';
import { CliBackendAdapter } from './cli/adapter.js';
import { OpenApiAdapter } from './openapi/adapter.js';
import { getBuiltinProviders, getMcpConfigs } from '../config/schema.js';
import type { UploadStore } from '../uploads/store.js';

/**
 * Build all BackendAdapter instances from the gateway config.
 * MCP adapters wrap the existing ClientPool; CLI and API adapters are standalone.
 */
export interface AdapterRuntimeDeps {
  airlock?: AirlockBackendDeps;
  uploadStore?: UploadStore;
}

export function buildAdapters(
  config: Config,
  pool: ClientPool,
  runtime: AdapterRuntimeDeps = {}
): BackendAdapter[] {
  const adapters: BackendAdapter[] = [];
  const uploadStore = runtime.uploadStore;

  // MCP adapters — one per connected MCP server
  const mcpConfigs = getMcpConfigs(config.providers);
  for (const mcpId of pool.getMcpIds()) {
    adapters.push(new McpBackendAdapter(mcpId, pool, mcpConfigs[mcpId], uploadStore));
  }

  // Builtin adapters
  const builtins = getBuiltinProviders(config.providers);
  if (builtins.has('exec')) {
    adapters.push(new ExecBackendAdapter(config.agents));
  }
  const uploadsEnabled = Boolean(config.uploads?.enabled);
  if (builtins.has('http')) {
    adapters.push(
      new HttpBackendAdapter(config.agents, config.security, uploadStore, uploadsEnabled)
    );
  }
  // The airlock/* adapter carries the approval plumbing (request_approval, await_approval) and
  // staged upload tools when uploads.enabled is true, so it is present unless an `airlock`
  // provider entry explicitly disables it. Without an `airlock` entry only those plumbing tools
  // are exposed; the rest need `airlock: builtin`.
  const airlockDeps: AirlockBackendDeps = {
    ...runtime.airlock,
    ...(uploadStore ? { uploadStore } : {}),
    uploadsEnabled,
  };
  if (builtins.has('airlock')) {
    adapters.push(new AirlockBackendAdapter(airlockDeps));
  } else if (!('airlock' in config.providers)) {
    adapters.push(new AirlockBackendAdapter(airlockDeps, true));
  }

  // CLI adapters — one per clis.{key} entry
  for (const [key, cliConfig] of Object.entries(config.clis ?? {})) {
    adapters.push(new CliBackendAdapter(key, cliConfig, undefined, uploadStore));
  }

  // OpenAPI adapters — one per apis.{key} entry
  for (const [key, apiConfig] of Object.entries(config.apis ?? {})) {
    adapters.push(new OpenApiAdapter(key, apiConfig, config.security, uploadStore));
  }

  return adapters;
}
