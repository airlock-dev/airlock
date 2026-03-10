import { z } from 'zod';

// Env var substitution helper
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
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
    headers: z.record(z.string()).optional(),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const ToolOverride = z.object({
  description: z.string().optional(),
});

export const AgentExecConfig = z.object({
  allow: z.array(z.string()).default([]),
  hitl: z.array(z.string()).default([]),
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

export const AgentConfig = z.object({
  allow: z.array(z.string()).default([]),
  hitl: z.array(z.string()).default([]),
  tool_overrides: z.record(ToolOverride).default({}),
  exec: AgentExecConfig.default({}),
  http: AgentHttpConfig.default({}),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const HitlProviderConfig = z.discriminatedUnion('type', [
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
    type: z.literal('stdio'),
  }),
]);
export type HitlProviderConfig = z.infer<typeof HitlProviderConfig>;

export const HitlConfig = z.object({
  provider: HitlProviderConfig.default({ type: 'stdio' }),
  timeout_ms: z.number().int().min(1000).default(300000), // 5 minutes
  batch_window_ms: z.number().int().min(0).default(10000),
});
export type HitlConfig = z.infer<typeof HitlConfig>;

export const SecurityConfig = z.object({
  blocked_hosts: z.array(z.string()).default([
    'localhost', '127.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1',
    '*.local',
    '10.*',
    '172.16.*', '172.17.*', '172.18.*', '172.19.*',
    '172.20.*', '172.21.*', '172.22.*', '172.23.*',
    '172.24.*', '172.25.*', '172.26.*', '172.27.*',
    '172.28.*', '172.29.*', '172.30.*', '172.31.*',
    '192.168.*',
    '169.254.*',
    'fc00:*', 'fd00:*', 'fe80:*',
  ]),
  allowed_local: z.array(z.string()).default([]),
});
export type SecurityConfig = z.infer<typeof SecurityConfig>;

export const AuditConfig = z.object({
  db_path: z.string().default('./audit.db'),
  retention_days: z.number().default(90),
  redact_fields: z.array(z.string()).default(['password', 'token', 'secret', 'key', 'authorization']),
});
export type AuditConfig = z.infer<typeof AuditConfig>;

export const ServerConfig = z.object({
  port: z.number().int().min(1).max(65535).default(4111),
  host: z.string().default('127.0.0.1'),
  api_secret: EnvString.optional(),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export const GatewayConfig = z.object({
  mcps: z.record(McpServerConfig).default({}),
  agents: z.record(AgentConfig).default({}),
  hitl: HitlConfig.default({}),
  security: SecurityConfig.default({}),
  audit: AuditConfig.default({}),
  server: ServerConfig.default({}),
});
export type GatewayConfig = z.infer<typeof GatewayConfig>;
