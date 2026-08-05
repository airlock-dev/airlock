import { homedir } from 'os';
import { z } from 'zod';

// Env var substitution helper
let resolveEnvVars = true;

export function withEnvVarResolution<T>(resolve: boolean, fn: () => T): T {
  const previous = resolveEnvVars;
  resolveEnvVars = resolve;
  try {
    return fn();
  } finally {
    resolveEnvVars = previous;
  }
}

function substituteEnvVars(value: string): string {
  if (!resolveEnvVars) return value;

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

/**
 * Operator-authored orientation text for a provider, surfaced to agents via the gateway's own
 * server-level `instructions` (MCP `initialize`). Use it for the things a vendor's own docs can't
 * know — house conventions, which IDs to use, which discovery calls lie.
 *
 * `instructions` is trusted (it comes from this config file, not the network) so it is never
 * scrubbed or truncated. `upstream_instructions` controls whether the provider's OWN advertised
 * instructions are included alongside it; set `ignore` to replace them outright.
 */
const ProviderInstructionsFields = {
  instructions: z.string().optional(),
  // `.optional()` rather than `.default('include')` so the parsed shape of a provider that never
  // mentions instructions is byte-identical to what it was before this feature existed. Absent
  // means include; getProviderInstructions() applies the fallback.
  upstream_instructions: z.enum(['include', 'ignore']).optional(),
};

/**
 * A cheap, read-only call used to prove the provider's CREDENTIAL still works — as opposed to
 * `mcpHealth`, which only proves the transport is reachable. The distinction is not academic: a
 * Google Workspace sidecar answers MCP happily for weeks after its refresh token dies, so the
 * gateway reported `ok` the entire time nobody could read mail.
 *
 * Pick the cheapest read the provider offers, and scope it tightly — this runs unattended.
 *
 * Classification: a thrown error or an `isError` result is a failure, and the failure text decides
 * `auth_required` vs `error`. Providers that report expired credentials as a SUCCESSFUL text
 * response (the Google sidecar's "ACTION REQUIRED: authorize…" is one) can't be caught that way,
 * which is what `expect_contains` / `reject_contains` are for. Prefer `expect_contains` and anchor
 * it on the shape of a healthy response: `reject_contains` matches the whole payload, so a probe
 * that returns user data can trip on the phrase appearing in that data (an email subject line
 * reading "Action Required" would do it).
 */
export const CredentialProbeConfig = z
  .object({
    /** Provider-local tool name — unprefixed, e.g. `search_gmail_messages`. */
    tool: z.string(),
    args: z.record(z.unknown()).default({}),
    /** Healthy responses must contain this substring; otherwise the credential is auth_required. */
    expect_contains: z.string().optional(),
    /** Healthy responses must NOT contain this substring. See the caveat above. */
    reject_contains: z.string().optional(),
    /** Cache TTL. Floored at a minute so a hot /health poll can't hammer a provider's API quota. */
    interval_ms: z.number().int().min(60_000).default(900_000),
    timeout_ms: z.number().int().min(1_000).default(15_000),
  })
  .strict();
export type CredentialProbeConfig = z.infer<typeof CredentialProbeConfig>;

const CredentialProbeFields = {
  credential_probe: CredentialProbeConfig.optional(),
};

/**
 * OAuth2 client-credentials grant — the gateway authenticates as the APPLICATION, with no user in
 * the loop and no browser flow. Use it for provider-side bot/service identities: actions land as
 * the app rather than as whoever last authorized it, which is what makes an autonomous agent's
 * writes attributable.
 *
 * Distinct from `oauth: true`, which is the authorization-code flow and carries a USER's identity.
 * The two are mutually exclusive (see the loader diagnostic) — a provider has one identity.
 *
 * Tokens are minted on demand, cached to disk, and re-minted proactively before expiry or reactively
 * on a 401. Disk caching is load-bearing rather than an optimization: issuers cap how many tokens an
 * app may hold at once (Linear allows 1000), so a gateway that minted on every restart would burn
 * through that quota.
 */
export const ClientCredentialsConfig = z
  .object({
    /** The issuer's token endpoint, e.g. `https://api.linear.app/oauth/token`. */
    token_url: z.string().url(),
    client_id: EnvString,
    client_secret: EnvString,
    /**
     * Scopes to request, verbatim — the separator is the issuer's to define (Linear uses commas,
     * the OAuth2 spec says spaces), so the string is passed through untouched. Omit to accept the
     * issuer's default scopes. NOTE: some issuers revoke every live token when an app's scopes
     * change, so treat this as a value that is changed deliberately, not tuned.
     */
    scope: z.string().optional(),
  })
  .strict();
export type ClientCredentialsConfig = z.infer<typeof ClientCredentialsConfig>;

export const McpServerConfig = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('stdio'),
      enabled: z.boolean().default(true),
      command: z.string(),
      args: z.array(z.string()).default([]),
      env: z.record(EnvString).optional(),
      ...ProviderInstructionsFields,
      ...CredentialProbeFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('sse'),
      enabled: z.boolean().default(true),
      url: z.string().url(),
      headers: z.record(EnvString).optional(),
      ...ProviderInstructionsFields,
      ...CredentialProbeFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('http'),
      enabled: z.boolean().default(true),
      url: z.string().url(),
      headers: z.record(EnvString).optional(),
      oauth: z.boolean().default(false),
      oauth_callback_port: z.number().int().min(1).max(65535).default(18432),
      oauth_callback_url: z.string().url().optional(),
      client_id: EnvString.optional(),
      client_secret: EnvString.optional(),
      client_credentials: ClientCredentialsConfig.optional(),
      /**
       * Per-request MCP SDK deadline. The SDK otherwise imposes an invisible 60s default even when
       * Airlock's outer call_execution_timeout_ms is higher, so slow but healthy providers can
       * never use the operator-configured execution budget.
       */
      request_timeout_ms: z.number().int().positive().default(60_000),
      ...ProviderInstructionsFields,
      ...CredentialProbeFields,
    })
    .strict(),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const BuiltinProviderConfig = z
  .object({
    type: z.literal('builtin'),
    enabled: z.boolean().default(true),
    ...ProviderInstructionsFields,
  })
  .strict();
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

/**
 * Credential probes for the providers that declare one, keyed by provider id. Providers without a
 * probe are simply absent — the monitor still reports on them, using the transport's own OAuth
 * state, and says `unknown` rather than guessing.
 */
export function getCredentialProbes(
  providers: Record<string, ProviderConfig>
): Record<string, CredentialProbeConfig> {
  const result: Record<string, CredentialProbeConfig> = {};
  for (const [id, cfg] of Object.entries(getMcpConfigs(providers))) {
    if (cfg.credential_probe) result[id] = cfg.credential_probe;
  }
  return result;
}

export interface ProviderInstructionsConfig {
  /** Operator-authored text. Trusted: never scrubbed or truncated. */
  instructions?: string;
  /** Whether the provider's own advertised instructions are included alongside it. */
  upstream: 'include' | 'ignore';
}

/**
 * Per-provider instruction settings, keyed by provider id. Providers declared as the bare string
 * `'builtin'` carry no settings and fall back to the defaults.
 */
export function getProviderInstructions(
  providers: Record<string, ProviderConfig>
): Record<string, ProviderInstructionsConfig> {
  const result: Record<string, ProviderInstructionsConfig> = {};
  for (const [id, cfg] of Object.entries(providers)) {
    if (cfg === 'builtin') continue;
    result[id] = {
      ...(cfg.instructions !== undefined && { instructions: cfg.instructions }),
      upstream: cfg.upstream_instructions ?? 'include',
    };
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

export const SandboxFilesystemConfig = z
  .object({
    allow_write: z.array(z.string()).default(['.', '/tmp']),
    deny_read: z.array(z.string()).default([]),
    deny_write: z.array(z.string()).default([]),
    allow_read: z.array(z.string()).optional(),
  })
  .strict();
export type SandboxFilesystemConfig = z.infer<typeof SandboxFilesystemConfig>;

export const SandboxNetworkConfig = z
  .object({
    allowed_domains: z.array(z.string()).default([]),
    denied_domains: z.array(z.string()).default([]),
  })
  .strict();
export type SandboxNetworkConfig = z.infer<typeof SandboxNetworkConfig>;

export const SandboxOverrideConfig = z
  .object({
    filesystem: SandboxFilesystemConfig.optional(),
    network: SandboxNetworkConfig.optional(),
  })
  .strict();
export type SandboxOverrideConfig = z.infer<typeof SandboxOverrideConfig>;

export const SandboxPresetRef = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]));
export type SandboxPresetRef = z.infer<typeof SandboxPresetRef>;

export const SandboxConfig = z
  .object({
    enabled: z.boolean().default(false),
    presets: SandboxPresetRef.default([]),
    filesystem: SandboxFilesystemConfig.default({}),
    network: SandboxNetworkConfig.default({}),
    overrides: z.record(SandboxOverrideConfig).default({}),
  })
  .strict();
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

// A command router for tools whose privilege lives inside a string argument — CLI-style dispatcher
// tools (e.g. an MCP that exposes one `exec`/`run` tool taking a command string, where read vs.
// write vs. admin is a substring of that argument, not a distinct tool name). Maps the arg's value
// to a decision by glob-matching it against allow/ask/deny lists. Precedence deny > ask > allow;
// anything unmatched is denied (fail-closed). Same shape and semantics as the `exec` sub-policy,
// generalized to any tool + arg. Composes through `extends` (the lists union across the chain).
export const CommandPolicyRuleConfig = z
  .object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    // Decision for a command that matches none of the lists. Defaults to `deny` (fail-closed).
    // Set `ask` for the common "these specific commands run/ask, everything else needs approval"
    // shape without a catch-all pattern that would shadow the narrower allow list.
    default: z.enum(['allow', 'ask', 'deny']).optional(),
  })
  .strict()
  .refine(
    (rule) =>
      rule.allow.length + rule.ask.length + rule.deny.length > 0 || rule.default !== undefined,
    {
      message: 'Command policy rule must define at least one allow/ask/deny pattern or a default.',
    }
  );
export type CommandPolicyRuleConfig = z.infer<typeof CommandPolicyRuleConfig>;

// tool name → arg name → decision lists
export const CommandPolicyConfig = z.record(z.record(CommandPolicyRuleConfig));
export type CommandPolicyConfig = z.infer<typeof CommandPolicyConfig>;

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

export const ToolOverride = z
  .object({
    /** Replaces the upstream description entirely. */
    description: z.string().optional(),
    /**
     * Appended after whatever description survives (upstream, or `description` when set). Use this
     * for house rules you want on top of the vendor's docs without restating them by hand.
     */
    description_append: z.string().optional(),
    alias_of: z.string().optional(),
    sandbox_presets: SandboxPresetRef.default([]),
    sandbox: SandboxOverrideConfig.optional(),
    args: z.record(ToolArgConstraintListConfig).optional(),
  })
  .strict();
export type ToolOverride = z.infer<typeof ToolOverride>;

export const AgentExecConfig = z
  .object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    default_timeout_ms: z.number().default(30000),
  })
  .strict();
export type AgentExecConfig = z.infer<typeof AgentExecConfig>;

export const AgentHttpConfig = z
  .object({
    domain_allowlist: z.array(z.string()).default([]),
    max_response_bytes: z.number().default(1048576), // 1MB
    timeout_ms: z.number().default(30000),
  })
  .strict();
export type AgentHttpConfig = z.infer<typeof AgentHttpConfig>;

export const RememberAllowRule = z
  .object({
    tool: z.string(),
    expires_at: z.string().optional(),
  })
  .strict();
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

// Per-agent resource safeties (bulkheads) so one agent cannot exhaust the gateway and
// starve the others. Every field is optional; unset fields fall back to the global
// `security.limits` block, then to built-in defaults (see resolveLimits). All *_ms fields
// treat 0 as "disabled". These limits are deliberately HITL-aware: the idle reaper never
// touches a session with an in-flight request (a call parked on human approval keeps its
// request open), and call_execution_timeout_ms clocks ONLY downstream execution — never the
// approval wait, which happens in an earlier middleware.
export const LimitsConfig = z
  .object({
    // Max concurrent open MCP sessions a single agent may hold (per transport plane).
    max_sessions_per_agent: z.number().int().positive().optional(),
    // Absolute ceiling on open sessions across ALL agents (backstop for the whole box).
    max_sessions_global: z.number().int().positive().optional(),
    // Reap a session after this long with NO in-flight request. 0 = never reap on idle.
    session_idle_ms: z.number().int().nonnegative().optional(),
    // Hard cap on total session lifetime regardless of activity. 0 = no lifetime cap
    // (default — an async task parked on approval for hours must survive).
    session_max_lifetime_ms: z.number().int().nonnegative().optional(),
    // Token-bucket rate limit on NEW sessions per agent: at most `new_session_max`
    // initializations per `new_session_window_ms`. Stops reconnect/init storms at the door.
    new_session_max: z.number().int().positive().optional(),
    new_session_window_ms: z.number().int().positive().optional(),
    // Max concurrently EXECUTING tool calls per agent (post-approval only; calls parked
    // awaiting HITL do not count). Bounds event-loop / upstream-pool monopolization.
    max_concurrent_calls_per_agent: z.number().int().positive().optional(),
    // Deadline on a single downstream tool execution, excluding any HITL approval wait.
    // 0 = disabled (default), so genuinely long async downstream calls are never severed.
    call_execution_timeout_ms: z.number().int().nonnegative().optional(),
  })
  .strict();
export type LimitsConfig = z.infer<typeof LimitsConfig>;

export const AgentConfig = z
  .object({
    token: EnvString.optional(),
    extends: z.array(z.string()).default([]),
    // Opt out of the top-level `default_profile` (which every agent otherwise inherits).
    // Set false for a locked-down agent that must get nothing implicitly. No effect when
    // `default_profile` is unset.
    inherit_default: z.boolean().default(true),
    allow: z.array(z.string()).default([]),
    remember_allow: z.array(RememberAllowRule).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    tool_overrides: z.record(ToolOverride).default({}),
    arg_policy: ToolArgPolicyConfig.optional(),
    arg_scope: ArgScopeConfig.optional(),
    command_policy: CommandPolicyConfig.optional(),
    exec: AgentExecConfig.default({}),
    http: AgentHttpConfig.default({}),
    sandbox: SandboxConfig.default({}),
    middleware: z.array(MiddlewareItemConfig).optional(),
    // Per-agent opt-in for the plain-HTTP tools API (POST /agents/:id/tools/invoke).
    // Consulted ONLY when server.expose_tools_api is 'per-agent'. Lets service consumers
    // (e.g. an ingestion job) use HTTP while interactive agents stay MCP-only.
    expose_tools_api: z.boolean().default(false),
    // Per-agent resource safeties; unset fields inherit from `security.limits` then defaults.
    limits: LimitsConfig.optional(),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfig>;

export const ProfileConfig = z
  .object({
    extends: z.array(z.string()).default([]),
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    // Composes through `extends` alongside the permission lists, so a profile that grants a
    // provider's tools can also carry the notes an agent needs to use them correctly.
    tool_overrides: z.record(ToolOverride).default({}),
    arg_policy: ToolArgPolicyConfig.optional(),
    arg_scope: ArgScopeConfig.optional(),
    command_policy: CommandPolicyConfig.optional(),
  })
  .strict();
export type ProfileConfig = z.infer<typeof ProfileConfig>;

export const ApprovalProviderConfig = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('telegram'),
      bot_token: EnvString,
      chat_id: EnvString,
    })
    .strict(),
  z
    .object({
      type: z.literal('openclaw'),
      gateway_url: z.string().default('ws://localhost:18789'),
      token: EnvString,
      session_key: z.string().default('main'),
    })
    .strict(),
  z
    .object({
      type: z.literal('slack'),
      webhook_url: EnvString,
    })
    .strict(),
  z
    .object({
      type: z.literal('webhook'),
      url: EnvString,
      headers: z.record(z.string()).default({}),
    })
    .strict(),
  z
    .object({
      type: z.literal('tui'),
    })
    .strict(),
  z
    .object({
      type: z.literal('macos'),
      sound: z.string().optional(), // macOS sound name, e.g. "Submarine", "Glass", "Ping"
    })
    .strict(),
  z
    .object({
      type: z.literal('dashboard'),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(4112),
    })
    .strict(),
  z
    .object({
      type: z.literal('ios'),
      team_id: EnvString,
      key_id: EnvString,
      key_path: PathString,
      bundle_id: z.string(),
      production: z.boolean().default(true),
      interruption_level: z.enum(['passive', 'active', 'time-sensitive']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('stdio'),
    })
    .strict(),
]);
export type ApprovalProviderConfig = z.infer<typeof ApprovalProviderConfig>;

// Keep HitlProviderConfig as an alias for internal code that references it
export type HitlProviderConfig = ApprovalProviderConfig;

export const ApprovalsConfig = z
  .object({
    provider: z
      .union([ApprovalProviderConfig, z.array(ApprovalProviderConfig)])
      .default({ type: 'stdio' }),
    timeout_ms: z.number().int().min(0).default(300000), // 5 minutes; 0 = no timeout
    batch_window_ms: z.number().int().min(0).default(0),
  })
  .strict();
export type ApprovalsConfig = z.infer<typeof ApprovalsConfig>;

// Keep HitlConfig as an alias for internal code
export type HitlConfig = ApprovalsConfig;

export const SecurityConfig = z
  .object({
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
    // Gateway-wide default resource safeties. Per-agent `limits` overrides these field-by-field.
    limits: LimitsConfig.optional(),
  })
  .strict();
export type SecurityConfig = z.infer<typeof SecurityConfig>;

export const AuditConfig = z
  .object({
    db_path: PathString.default('./audit.db'),
    retention_days: z.number().default(90),
    redact_fields: z
      .array(z.string())
      .default(['password', 'token', 'secret', 'key', 'authorization']),
  })
  .strict();
export type AuditConfig = z.infer<typeof AuditConfig>;

export const ManagementApiConfig = z
  .object({
    enabled: z.boolean().default(false),
    api_secret: EnvString.optional(),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(4113),
    insecure_remote_bind: z.boolean().default(false),
    expose_hook_api: z.boolean().default(true),
  })
  .strict();
export type ManagementApiConfig = z.infer<typeof ManagementApiConfig>;

// HTTP tools-API exposure mode (POST /agents/:id/tools/invoke):
//   'all'       — every agent gets the HTTP transport.
//   'none'      — no agent gets it; a hard kill-switch that overrides per-agent opt-ins.
//   'per-agent' — each agent's `expose_tools_api` (default false) decides.
// Legacy booleans are accepted: true → 'all', false → 'none'.
export const ToolsApiMode = z.enum(['all', 'none', 'per-agent']);
export type ToolsApiMode = z.infer<typeof ToolsApiMode>;
const ToolsApiModeConfig = z.preprocess(
  (v) => (v === true ? 'all' : v === false ? 'none' : v),
  ToolsApiMode
);

export const ServerConfig = z
  .object({
    port: z.number().int().min(1).max(65535).default(4111),
    host: z.string().default('127.0.0.1'),
    api_secret: EnvString.optional(),
    auth_required: z.boolean().default(false),
    require_agent_tokens: z.boolean().default(false),
    allowed_origins: z.array(z.string()).default([]),
    expose_tools_api: ToolsApiModeConfig.default('per-agent'),
    management_api: ManagementApiConfig.default({}),
    // Deprecated compatibility aliases. Runtime code must use management_api.
    expose_management_api: z.boolean().optional(),
    expose_hook_api: z.boolean().optional(),
  })
  .strict()
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

export const LINT_RULE_IDS = [
  'dead-deny',
  'unused-profile',
  'unused-value-set',
  'unused-dimension',
  'empty-agent',
  'missing-env-ref',
  'unresolvable-ref',
  'unallocated-tool',
  'dead-allow',
] as const;
export type LintRuleId = (typeof LINT_RULE_IDS)[number];

export const LintRuleIdConfig = z.enum(LINT_RULE_IDS);
export const LintRuleSeverityConfig = z.enum(['info', 'warn', 'error']);
export type LintRuleSeverity = z.infer<typeof LintRuleSeverityConfig>;

export const LintConfig = z
  .object({
    disable: z.array(LintRuleIdConfig).default([]),
    severity: z.record(LintRuleIdConfig, LintRuleSeverityConfig).default({}),
  })
  .strict();
export type LintConfig = z.infer<typeof LintConfig>;

// --- CLI backend config ---

export const CliParamConfig = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    flag: z.string().regex(/^-/, 'Flag must start with a dash (e.g. -n, --verbose)').optional(),
    positional: z.boolean().default(false),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })
  .strict();
export type CliParamConfig = z.infer<typeof CliParamConfig>;

export const CliCommandConfig = z
  .object({
    exec: z.string(),
    description: z.string().optional(),
    params: z.record(CliParamConfig).default({}),
    cwd: PathString.optional(),
    timeout: z.number().default(30),
  })
  .strict();
export type CliCommandConfig = z.infer<typeof CliCommandConfig>;

export const CliConfig = z
  .object({
    discovered: PathString.optional(),
    shell: PathString.optional(),
    cwd: PathString.optional(),
    max_output_bytes: z.number().default(30_000),
    commands: z.record(CliCommandConfig).default({}),
  })
  .strict();
export type CliConfig = z.infer<typeof CliConfig>;

// --- OpenAPI backend config ---

export const ApiAuthConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer'), token: EnvString }).strict(),
  z.object({ type: z.literal('header'), name: z.string(), value: EnvString }).strict(),
]);
export type ApiAuthConfig = z.infer<typeof ApiAuthConfig>;

export const ApiConfig = z
  .object({
    spec: PathString,
    base_url: z.string().optional(),
    auth: ApiAuthConfig.optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    timeout_ms: z.number().default(30000),
    max_response_bytes: z.number().default(1048576),
  })
  .strict();
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
    // Optional profile that every agent inherits at lowest precedence, for DRY low-risk grants
    // (e.g. self-inspection tools). Injected at the front of each agent's `extends`, so an agent
    // can still override it (deny > ask > allow), and opt out entirely via `inherit_default: false`.
    // The named profile may itself `extends` a chain, so one entry composes many.
    default_profile: z.string().optional(),
    sandbox_presets: z.record(SandboxPresetConfig).default({}),
    clis: z.record(CliConfig).default({}),
    apis: z.record(ApiConfig).default({}),
    agents: z.record(AgentConfig).default({}),
    approvals: ApprovalsConfig.default({}),
    security: SecurityConfig.default({}),
    audit: AuditConfig.default({}),
    server: ServerConfig.default({}),
    lint: LintConfig.default({}),
  })
  .strict()
  .transform((config) => ({
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([key, value]) => [
        key,
        applyDefaultProfileToAgent(
          applySandboxPresetsToAgent(value, config.sandbox_presets),
          config.default_profile,
          config.profiles
        ),
      ])
    ),
  }));
export type GatewayConfig = z.infer<typeof GatewayConfig>;

// Prepend the top-level `default_profile` to an agent's `extends` so it resolves at lowest
// precedence and both the runtime resolver (applyProfiles) and the CLI `explain` path pick it up
// from one place. Skipped when: no default is configured, the agent opted out via
// `inherit_default: false`, the agent already extends it (avoid a duplicate in the extends tree),
// or the profile does not exist — the last case is surfaced as a single clear diagnostic by
// validateConfig rather than one confusing unknown-profile-ref per agent.
function applyDefaultProfileToAgent(
  agent: AgentConfig,
  defaultProfile: string | undefined,
  profiles: Record<string, ProfileConfig>
): AgentConfig {
  if (
    !defaultProfile ||
    !agent.inherit_default ||
    !profiles[defaultProfile] ||
    agent.extends.includes(defaultProfile)
  ) {
    return agent;
  }
  return { ...agent, extends: [defaultProfile, ...agent.extends] };
}
