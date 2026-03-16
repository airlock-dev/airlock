import { z } from 'zod';

// Env var substitution helper
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    const val = process.env[varName];
    if (val === undefined) {
      throw new Error(`Required environment variable ${varName} is not set`);
    }
    return val;
  });
}

const EnvString = z.string().transform(substituteEnvVars);

export const McpServerConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(EnvString).optional(),
  }),
  z.object({
    type: z.literal('sse'),
    url: z.string().url(),
    headers: z.record(EnvString).optional(),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    headers: z.record(EnvString).optional(),
    oauth: z.boolean().default(false),
    oauth_callback_port: z.number().int().min(1).max(65535).default(18432),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const ProviderConfig = z.union([z.literal('builtin'), McpServerConfig]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** Extract only MCP server configs from the providers map */
export function getMcpConfigs(
  providers: Record<string, ProviderConfig>
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [id, cfg] of Object.entries(providers)) {
    if (cfg !== 'builtin') {
      result[id] = cfg;
    }
  }
  return result;
}

/** Extract the set of builtin provider names (e.g. "exec", "http") */
export function getBuiltinProviders(providers: Record<string, ProviderConfig>): Set<string> {
  const result = new Set<string>();
  for (const [id, cfg] of Object.entries(providers)) {
    if (cfg === 'builtin') {
      result.add(id);
    }
  }
  return result;
}

export const ToolOverride = z.object({
  description: z.string().optional(),
});

export const AgentExecConfig = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  default_timeout_ms: z.number().default(30000),
});
export type AgentExecConfig = z.infer<typeof AgentExecConfig>;

export const AgentHttpConfig = z.object({
  domain_allowlist: z.array(z.string()).default([]),
  max_response_bytes: z.number().default(1048576), // 1MB
  timeout_ms: z.number().default(30000),
});
export type AgentHttpConfig = z.infer<typeof AgentHttpConfig>;

export const MiddlewareItemConfig = z
  .object({
    name: z.enum([
      'schema-validator',
      'rate-limiter',
      'untrusted-envelope',
      'strip-query-params',
      'output-injection-detector',
      'canary-token-injector',
      'output-size-limiter',
      'output-summarizer',
      'injection-detector',
      'sensitivity-classifier',
    ]),
    enabled: z.boolean().default(true),
    // tool filtering — glob patterns (e.g. "github/*", "http/get")
    tools: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    // rate-limiter
    max_requests: z.number().optional(),
    window_ms: z.number().optional(),
    per: z.enum(['agent', 'tool']).optional(),
    // output-injection-detector
    mode: z.enum(['detect', 'mangle', 'escalate']).optional(),
    // injection-detector
    backend: z.enum(['regex', 'deberta', 'heuristic', 'llm']).optional(),
    inference_url: z.string().optional(),
    threshold: z.number().optional(),
    // output-size-limiter
    max_lines: z.number().optional(),
    max_chars: z.number().optional(),
    // output-summarizer / sensitivity-classifier
    model: z.string().optional(),
    threshold_chars: z.number().optional(),
  })
  .strict();
export type MiddlewareItemConfig = z.infer<typeof MiddlewareItemConfig>;

export const AgentConfig = z.object({
  token: EnvString.optional(),
  extends: z.array(z.string()).default([]),
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  tool_overrides: z.record(ToolOverride).default({}),
  exec: AgentExecConfig.default({}),
  http: AgentHttpConfig.default({}),
  middleware: z.array(MiddlewareItemConfig).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const ProfileConfig = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
});
export type ProfileConfig = z.infer<typeof ProfileConfig>;

export const ApprovalProviderConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('telegram'),
    bot_token: EnvString,
    chat_id: EnvString,
  }),
  z.object({
    type: z.literal('openclaw'),
    gateway_url: z.string().default('ws://localhost:18789'),
    token: EnvString,
    session_key: z.string().default('main'),
  }),
  z.object({
    type: z.literal('slack'),
    webhook_url: EnvString,
  }),
  z.object({
    type: z.literal('webhook'),
    url: EnvString,
    headers: z.record(z.string()).default({}),
  }),
  z.object({
    type: z.literal('tui'),
  }),
  z.object({
    type: z.literal('macos'),
    sound: z.string().optional(), // macOS sound name, e.g. "Submarine", "Glass", "Ping"
  }),
  z.object({
    type: z.literal('dashboard'),
    port: z.number().int().min(1).max(65535).default(4112),
  }),
  z.object({
    type: z.literal('stdio'),
  }),
]);
export type ApprovalProviderConfig = z.infer<typeof ApprovalProviderConfig>;

// Keep HitlProviderConfig as an alias for internal code that references it
export type HitlProviderConfig = ApprovalProviderConfig;

export const ApprovalsConfig = z.object({
  provider: z
    .union([ApprovalProviderConfig, z.array(ApprovalProviderConfig).min(1)])
    .default({ type: 'stdio' }),
  timeout_ms: z.number().int().min(1000).default(300000), // 5 minutes
  batch_window_ms: z.number().int().min(0).default(0),
});
export type ApprovalsConfig = z.infer<typeof ApprovalsConfig>;

// Keep HitlConfig as an alias for internal code
export type HitlConfig = ApprovalsConfig;

export const SecurityConfig = z.object({
  blocked_hosts: z
    .array(z.string())
    .default([
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '::ffff:127.0.0.1',
      '*.local',
      '10.*',
      '172.16.*',
      '172.17.*',
      '172.18.*',
      '172.19.*',
      '172.20.*',
      '172.21.*',
      '172.22.*',
      '172.23.*',
      '172.24.*',
      '172.25.*',
      '172.26.*',
      '172.27.*',
      '172.28.*',
      '172.29.*',
      '172.30.*',
      '172.31.*',
      '192.168.*',
      '169.254.*',
      'fc00:*',
      'fd00:*',
      'fe80:*',
    ]),
  allowed_local: z.array(z.string()).default([]),
});
export type SecurityConfig = z.infer<typeof SecurityConfig>;

export const AuditConfig = z.object({
  db_path: z.string().default('./audit.db'),
  retention_days: z.number().default(90),
  redact_fields: z
    .array(z.string())
    .default(['password', 'token', 'secret', 'key', 'authorization']),
});
export type AuditConfig = z.infer<typeof AuditConfig>;

export const ServerConfig = z.object({
  port: z.number().int().min(1).max(65535).default(4111),
  host: z.string().default('127.0.0.1'),
  api_secret: EnvString.optional(),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

// --- CLI backend config ---

export const CliParamConfig = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  flag: z.string().regex(/^-/, 'Flag must start with a dash (e.g. -n, --verbose)').optional(),
  positional: z.boolean().default(false),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
});
export type CliParamConfig = z.infer<typeof CliParamConfig>;

export const CliCommandConfig = z.object({
  exec: z.string(),
  description: z.string().optional(),
  params: z.record(CliParamConfig).default({}),
  cwd: z.string().optional(),
  timeout: z.number().default(30),
});
export type CliCommandConfig = z.infer<typeof CliCommandConfig>;

export const CliConfig = z.object({
  discovered: z.string().optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  max_output_bytes: z.number().default(30_000),
  commands: z.record(CliCommandConfig).default({}),
});
export type CliConfig = z.infer<typeof CliConfig>;

// --- OpenAPI backend config ---

export const ApiAuthConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer'), token: EnvString }),
  z.object({ type: z.literal('header'), name: z.string(), value: EnvString }),
]);
export type ApiAuthConfig = z.infer<typeof ApiAuthConfig>;

export const ApiConfig = z.object({
  spec: z.string(),
  base_url: z.string().optional(),
  auth: ApiAuthConfig.optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  timeout_ms: z.number().default(30000),
  max_response_bytes: z.number().default(1048576),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

export const GatewayConfig = z.object({
  providers: z.record(ProviderConfig).default({}),
  profiles: z.record(ProfileConfig).default({}),
  clis: z.record(CliConfig).default({}),
  apis: z.record(ApiConfig).default({}),
  agents: z.record(AgentConfig).default({}),
  approvals: ApprovalsConfig.default({}),
  security: SecurityConfig.default({}),
  audit: AuditConfig.default({}),
  server: ServerConfig.default({}),
});
export type GatewayConfig = z.infer<typeof GatewayConfig>;
