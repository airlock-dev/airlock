import { homedir } from 'os';
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

// Expand leading ~ to the user's home directory
function expandTilde(value: string): string {
  if (value === '~' || value.startsWith('~/')) {
    return homedir() + value.slice(1);
  }
  return value;
}

const EnvString = z.string().transform(substituteEnvVars);
const PathString = z.string().transform(expandTilde);

export const McpServerConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    enabled: z.boolean().default(true),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(EnvString).optional(),
  }),
  z.object({
    type: z.literal('sse'),
    enabled: z.boolean().default(true),
    url: z.string().url(),
    headers: z.record(EnvString).optional(),
  }),
  z.object({
    type: z.literal('http'),
    enabled: z.boolean().default(true),
    url: z.string().url(),
    headers: z.record(EnvString).optional(),
    oauth: z.boolean().default(false),
    oauth_callback_port: z.number().int().min(1).max(65535).default(18432),
    oauth_callback_url: z.string().url().optional(),
    client_id: EnvString.optional(),
    client_secret: EnvString.optional(),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const BuiltinProviderConfig = z.object({
  type: z.literal('builtin'),
  enabled: z.boolean().default(true),
});
export type BuiltinProviderConfig = z.infer<typeof BuiltinProviderConfig>;

export const ProviderConfig = z.union([
  z.literal('builtin'),
  BuiltinProviderConfig,
  McpServerConfig,
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** Extract only MCP server configs from the providers map */
export function getMcpConfigs(
  providers: Record<string, ProviderConfig>
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [id, cfg] of Object.entries(providers)) {
    if (cfg !== 'builtin' && cfg.type !== 'builtin' && cfg.enabled !== false) {
      result[id] = cfg;
    }
  }
  return result;
}

/** Extract the set of builtin provider names (e.g. "exec", "http") */
export function getBuiltinProviders(providers: Record<string, ProviderConfig>): Set<string> {
  const result = new Set<string>();
  for (const [id, cfg] of Object.entries(providers)) {
    if (cfg === 'builtin' || (cfg.type === 'builtin' && cfg.enabled !== false)) {
      result.add(id);
    }
  }
  return result;
}

export const SandboxFilesystemConfig = z.object({
  allow_write: z.array(z.string()).default(['.', '/tmp']),
  deny_read: z.array(z.string()).default([]),
  deny_write: z.array(z.string()).default([]),
  allow_read: z.array(z.string()).optional(),
});
export type SandboxFilesystemConfig = z.infer<typeof SandboxFilesystemConfig>;

export const SandboxNetworkConfig = z.object({
  allowed_domains: z.array(z.string()).default([]),
  denied_domains: z.array(z.string()).default([]),
});
export type SandboxNetworkConfig = z.infer<typeof SandboxNetworkConfig>;

export const SandboxOverrideConfig = z.object({
  filesystem: SandboxFilesystemConfig.optional(),
  network: SandboxNetworkConfig.optional(),
});
export type SandboxOverrideConfig = z.infer<typeof SandboxOverrideConfig>;

export const SandboxPresetRef = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]));
export type SandboxPresetRef = z.infer<typeof SandboxPresetRef>;

export const SandboxConfig = z.object({
  enabled: z.boolean().default(false),
  presets: SandboxPresetRef.default([]),
  filesystem: SandboxFilesystemConfig.default({}),
  network: SandboxNetworkConfig.default({}),
  overrides: z.record(SandboxOverrideConfig).default({}),
});
export type SandboxConfig = z.infer<typeof SandboxConfig>;

export const ValueSetConfig = z
  .union([
    z.array(z.unknown()).nonempty(),
    z
      .object({
        values: z.array(z.unknown()).nonempty(),
        expose_values: z.boolean().default(true),
      })
      .strict(),
  ])
  .transform((value) => (Array.isArray(value) ? { values: value, expose_values: true } : value));
export type ValueSetConfig = z.infer<typeof ValueSetConfig>;

const NormalizerName = z.enum(['phone', 'email', 'lower', 'trim']);
export type NormalizerName = z.infer<typeof NormalizerName>;

export const ToolArgConstraintConfig = z
  .object({
    allow: z.array(z.unknown()).optional(),
    equals: z.unknown().optional(),
    in: z.string().optional(),
    glob_in: z.string().optional(),
    each_in: z.string().optional(),
    glob_allow: z.array(z.string()).optional(),
    each_allow: z.array(z.unknown()).optional(),
    normalize: z.array(NormalizerName).optional(),
    path: z.string().optional(),
    required: z.boolean().optional(),
    label: z.string().optional(),
    value_set: z.string().optional(),
    expose_values: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const matcherKeys = [
      'equals',
      'allow',
      'in',
      'glob_in',
      'each_in',
      'glob_allow',
      'each_allow',
    ] as const;
    const presentMatchers = matcherKeys.filter((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    );

    if (presentMatchers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Argument policy constraint must define exactly one matcher.',
      });
    }

    if (presentMatchers.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Argument policy constraint must define exactly one matcher.',
      });
    }

    if (Object.prototype.hasOwnProperty.call(value, 'allow') && value.allow?.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allow'],
        message: 'Argument policy allow list must contain at least one value.',
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(value, 'glob_allow') &&
      value.glob_allow?.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['glob_allow'],
        message: 'Argument policy glob_allow list must contain at least one value.',
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(value, 'each_allow') &&
      value.each_allow?.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['each_allow'],
        message: 'Argument policy each_allow list must contain at least one value.',
      });
    }
  });
export type ToolArgConstraintConfig = z.infer<typeof ToolArgConstraintConfig>;

export const ToolArgConstraintListConfig = z
  .union([ToolArgConstraintConfig, z.array(ToolArgConstraintConfig).nonempty()])
  .transform((value) => (Array.isArray(value) ? value : [value]));
export type ToolArgConstraintListConfig = z.infer<typeof ToolArgConstraintListConfig>;

export const ToolArgPolicyConfig = z.record(z.record(ToolArgConstraintListConfig));
export type ToolArgPolicyConfig = z.infer<typeof ToolArgPolicyConfig>;

export const ArgScopeConfig = z
  .record(z.union([z.string(), z.array(z.string()).nonempty()]))
  .transform((scope) =>
    Object.fromEntries(
      Object.entries(scope).map(([dimension, value]) => [
        dimension,
        Array.isArray(value) ? value : [value],
      ])
    )
  );
export type ArgScopeConfig = z.infer<typeof ArgScopeConfig>;

export const ArgDimensionConfig = z
  .object({
    match: z.enum(['in', 'glob_in', 'each_in']).default('in'),
    normalize: z.array(NormalizerName).optional(),
    bindings: z.record(z.string()),
  })
  .strict();
export type ArgDimensionConfig = z.infer<typeof ArgDimensionConfig>;

export const ToolOverride = z.object({
  description: z.string().optional(),
  alias_of: z.string().optional(),
  sandbox_presets: SandboxPresetRef.default([]),
  sandbox: SandboxOverrideConfig.optional(),
  args: z.record(ToolArgConstraintListConfig).optional(),
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

export const RememberAllowRule = z.object({
  tool: z.string(),
  expires_at: z.string().optional(),
});
export type RememberAllowRule = z.infer<typeof RememberAllowRule>;

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
  remember_allow: z.array(RememberAllowRule).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  tool_overrides: z.record(ToolOverride).default({}),
  arg_policy: ToolArgPolicyConfig.optional(),
  arg_scope: ArgScopeConfig.optional(),
  exec: AgentExecConfig.default({}),
  http: AgentHttpConfig.default({}),
  sandbox: SandboxConfig.default({}),
  middleware: z.array(MiddlewareItemConfig).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const ProfileConfig = z.object({
  extends: z.array(z.string()).default([]),
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  arg_policy: ToolArgPolicyConfig.optional(),
  arg_scope: ArgScopeConfig.optional(),
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
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(4112),
  }),
  z.object({
    type: z.literal('ios'),
    team_id: EnvString,
    key_id: EnvString,
    key_path: PathString,
    bundle_id: z.string(),
    production: z.boolean().default(true),
    interruption_level: z.enum(['passive', 'active', 'time-sensitive']).optional(),
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
  timeout_ms: z.number().int().min(0).default(300000), // 5 minutes; 0 = no timeout
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
  db_path: PathString.default('./audit.db'),
  retention_days: z.number().default(90),
  redact_fields: z
    .array(z.string())
    .default(['password', 'token', 'secret', 'key', 'authorization']),
});
export type AuditConfig = z.infer<typeof AuditConfig>;

export const ManagementApiConfig = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(4113),
  insecure_remote_bind: z.boolean().default(false),
  expose_hook_api: z.boolean().default(true),
});
export type ManagementApiConfig = z.infer<typeof ManagementApiConfig>;

export const ServerConfig = z
  .object({
    port: z.number().int().min(1).max(65535).default(4111),
    host: z.string().default('127.0.0.1'),
    api_secret: EnvString.optional(),
    auth_required: z.boolean().default(false),
    require_agent_tokens: z.boolean().default(false),
    allowed_origins: z.array(z.string()).default([]),
    expose_tools_api: z.boolean().default(true),
    management_api: ManagementApiConfig.default({}),
    // Deprecated compatibility aliases. Runtime code must use management_api.
    expose_management_api: z.boolean().optional(),
    expose_hook_api: z.boolean().optional(),
  })
  .transform((server) => {
    const management_api = {
      ...server.management_api,
      ...(server.expose_management_api !== undefined
        ? { enabled: server.expose_management_api }
        : {}),
      ...(server.expose_hook_api !== undefined ? { expose_hook_api: server.expose_hook_api } : {}),
    };

    return {
      ...server,
      management_api,
    };
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
  cwd: PathString.optional(),
  timeout: z.number().default(30),
});
export type CliCommandConfig = z.infer<typeof CliCommandConfig>;

export const CliConfig = z.object({
  discovered: PathString.optional(),
  shell: PathString.optional(),
  cwd: PathString.optional(),
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
  spec: PathString,
  base_url: z.string().optional(),
  auth: ApiAuthConfig.optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  timeout_ms: z.number().default(30000),
  max_response_bytes: z.number().default(1048576),
});
export type ApiConfig = z.infer<typeof ApiConfig>;

export const SandboxPresetConfig = SandboxOverrideConfig;
export type SandboxPresetConfig = z.infer<typeof SandboxPresetConfig>;

function mergeSandboxOverride(
  base: SandboxOverrideConfig,
  override: SandboxOverrideConfig
): SandboxOverrideConfig {
  const result: SandboxOverrideConfig = {
    filesystem: base.filesystem ? { ...base.filesystem } : undefined,
    network: base.network ? { ...base.network } : undefined,
  };

  if (override.filesystem) {
    result.filesystem = {
      ...(result.filesystem ?? {}),
      ...override.filesystem,
      ...(override.filesystem.deny_read !== undefined
        ? {
            deny_read: [...(result.filesystem?.deny_read ?? []), ...override.filesystem.deny_read],
          }
        : {}),
      ...(override.filesystem.deny_write !== undefined
        ? {
            deny_write: [
              ...(result.filesystem?.deny_write ?? []),
              ...override.filesystem.deny_write,
            ],
          }
        : {}),
    };
  }

  if (override.network) {
    result.network = {
      ...(result.network ?? {}),
      ...override.network,
      ...(override.network.denied_domains !== undefined
        ? {
            denied_domains: [
              ...(result.network?.denied_domains ?? []),
              ...override.network.denied_domains,
            ],
          }
        : {}),
    };
  }

  return result;
}

function applySandboxPresetsToConfig<
  T extends { sandbox_presets?: string[]; sandbox?: SandboxOverrideConfig },
>(value: T, sandboxPresets: Record<string, SandboxPresetConfig>): T {
  const presetNames = value.sandbox_presets ?? [];
  if (presetNames.length === 0) return value;

  let merged: SandboxOverrideConfig = {};
  for (const presetName of presetNames) {
    const preset = sandboxPresets[presetName];
    if (preset) merged = mergeSandboxOverride(merged, preset);
  }

  if (value.sandbox) {
    merged = mergeSandboxOverride(merged, value.sandbox);
  }

  return {
    ...value,
    sandbox: merged,
  };
}

function applySandboxPresetsToAgent(
  agent: AgentConfig,
  sandboxPresets: Record<string, SandboxPresetConfig>
): AgentConfig {
  let sandbox: SandboxConfig = { ...agent.sandbox };

  for (const presetName of sandbox.presets) {
    const preset = sandboxPresets[presetName];
    if (!preset) continue;

    if (preset.filesystem) {
      sandbox = {
        ...sandbox,
        filesystem: {
          ...sandbox.filesystem,
          ...preset.filesystem,
          ...(preset.filesystem.deny_read !== undefined
            ? {
                deny_read: [...sandbox.filesystem.deny_read, ...preset.filesystem.deny_read],
              }
            : {}),
          ...(preset.filesystem.deny_write !== undefined
            ? {
                deny_write: [...sandbox.filesystem.deny_write, ...preset.filesystem.deny_write],
              }
            : {}),
        },
      };
    }

    if (preset.network) {
      sandbox = {
        ...sandbox,
        network: {
          ...sandbox.network,
          ...preset.network,
          ...(preset.network.denied_domains !== undefined
            ? {
                denied_domains: [
                  ...sandbox.network.denied_domains,
                  ...preset.network.denied_domains,
                ],
              }
            : {}),
        },
      };
    }
  }

  const tool_overrides = Object.fromEntries(
    Object.entries(agent.tool_overrides).map(([key, value]) => [
      key,
      applySandboxPresetsToConfig(value, sandboxPresets),
    ])
  );

  return {
    ...agent,
    sandbox,
    tool_overrides,
  };
}

export const GatewayConfig = z
  .object({
    providers: z.record(ProviderConfig).default({}),
    value_sets: z.record(ValueSetConfig).default({}),
    arg_dimensions: z.record(ArgDimensionConfig).default({}),
    profiles: z.record(ProfileConfig).default({}),
    sandbox_presets: z.record(SandboxPresetConfig).default({}),
    clis: z.record(CliConfig).default({}),
    apis: z.record(ApiConfig).default({}),
    agents: z.record(AgentConfig).default({}),
    approvals: ApprovalsConfig.default({}),
    security: SecurityConfig.default({}),
    audit: AuditConfig.default({}),
    server: ServerConfig.default({}),
  })
  .transform((config) => ({
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([key, value]) => [
        key,
        applySandboxPresetsToAgent(value, config.sandbox_presets),
      ])
    ),
  }));
export type GatewayConfig = z.infer<typeof GatewayConfig>;
