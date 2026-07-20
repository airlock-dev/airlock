import { parseArgs } from 'util';
import { AllowlistEngine, type DetailedDecision } from '../allowlist/engine.js';
import { matches } from '../allowlist/pattern.js';
import { loadConfigDetailed, type Config, type ConfigDiagnostic } from '../config/loader.js';
import {
  explainAgentPermissions,
  type AgentPermissionExplanation,
  type PermissionWithProvenance,
} from '../config/profiles.js';
import { LINT_RULE_IDS, type LintRuleId, type LintRuleSeverity } from '../config/schema.js';
import { discoverTools } from '../configure-web/cli.js';

type CheckFailLevel = 'warn' | 'error';
type PermissionLevel = 'allow' | 'ask' | 'deny' | 'any';
type LintRuleMode = LintRuleSeverity | 'off';

interface LoadedForCli {
  config: Config;
  rawConfig: Config;
  diagnostics: ConfigDiagnostic[];
}

export interface LintFinding {
  rule: LintRuleId;
  severity: LintRuleSeverity;
  agent?: string;
  message: string;
  suggestion?: string;
  example: string;
}

interface LintRuleGroup {
  rule: LintRuleId;
  severity: LintRuleSeverity;
  count: number;
  findings: LintFinding[];
}

interface LintControls {
  activeRules: Set<LintRuleId>;
  severity: Record<LintRuleId, LintRuleSeverity>;
}

const DEFAULT_LINT_SEVERITY: Record<LintRuleId, LintRuleSeverity> = {
  'dead-deny': 'info',
  'unused-profile': 'info',
  'unused-value-set': 'info',
  'unused-dimension': 'info',
  'empty-agent': 'warn',
  'missing-env-ref': 'warn',
  'unresolvable-ref': 'warn',
  'unallocated-tool': 'info',
  'dead-allow': 'warn',
};

const LINT_RULE_LABELS: Record<LintRuleId, string> = {
  'dead-deny': 'Deny pattern does not overlap any allow/ask pattern.',
  'unused-profile': 'Profile is not referenced by any agent.',
  'unused-value-set': 'Value set is not referenced by arg_scope or arg_policy.',
  'unused-dimension': 'Argument dimension is not referenced by arg_scope.',
  'empty-agent': 'Agent resolves to zero allow/ask tools.',
  'missing-env-ref': 'Environment variable reference is unset.',
  'unresolvable-ref': 'Extends, arg_scope, or value_set reference cannot be resolved.',
  'unallocated-tool': 'Provider serves a tool no agent can reach.',
  'dead-allow': 'Grant names a tool the provider does not serve.',
};

export async function runIntrospection(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (command === 'config') {
    if (argv[1] !== 'check') {
      console.error(`Unknown config command: "${argv[1] ?? ''}". Use "config check".`);
      process.exit(1);
    }
    const result = checkConfig(argv.slice(2));
    writeResult(result, result.exitCode);
    return;
  }

  if (command === 'explain') {
    const result = await explainCommand(argv.slice(1));
    writeResult(result, result.exitCode);
    return;
  }

  if (command === 'who-can') {
    const result = whoCanCommand(argv.slice(1));
    writeResult(result, result.exitCode);
    return;
  }

  if (command === 'tools') {
    const result = await toolsCommand(argv.slice(1));
    writeResult(result, result.exitCode);
    return;
  }

  if (command === 'lint') {
    const result = await lintCommand(argv.slice(1));
    writeResult(result, result.exitCode);
    return;
  }

  console.error(`Unknown introspection command: "${command}".`);
  printHelp();
  process.exit(1);
}

export function checkConfig(argv: string[]): CliResult {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      strict: { type: 'boolean', default: false },
      'no-resolve': { type: 'boolean', default: false },
      'fail-on': { type: 'string', default: 'error' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    return ok(configCheckHelp(), values.json);
  }

  const failOn = parseCheckFailLevel(values['fail-on']);
  const loaded = loadConfigDetailed(values.config ?? './airlock.yaml', {
    strict: values.strict,
    resolveEnv: !values['no-resolve'],
  });
  const exitCode = shouldFail(loaded.diagnostics, failOn) ? 1 : 0;
  const payload = {
    ok: exitCode === 0,
    configPath: values.config,
    strict: values.strict,
    resolveEnv: !values['no-resolve'],
    failOn,
    diagnostics: groupDiagnostics(loaded.diagnostics),
  };

  return {
    json: values.json,
    exitCode,
    data: payload,
    text: formatCheck(payload),
  };
}

async function explainCommand(argv: string[]): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      expand: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    return {
      json: values.json,
      exitCode: positionals.length === 0 && !values.help ? 1 : 0,
      data: explainHelp(),
      text: explainHelp(),
    };
  }

  const loaded = loadForCli(values.config ?? './airlock.yaml');
  if ('result' in loaded) return loaded.result(values.json);

  const explanation = explainAgentPermissions(loaded.rawConfig, positionals[0]);
  const engine = new AllowlistEngine(loaded.config.agents);
  const expanded = values.expand
    ? await expandedDecisions(values.config ?? './airlock.yaml', explanation, engine)
    : undefined;
  const payload = {
    agent: positionals[0],
    explanation,
    precedence: precedenceNotes(explanation),
    expanded,
  };

  return {
    json: values.json,
    exitCode: 0,
    data: payload,
    text: formatExplain(payload),
  };
}

function whoCanCommand(argv: string[]): CliResult {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      level: { type: 'string', default: 'any' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    return {
      json: values.json,
      exitCode: positionals.length === 0 && !values.help ? 1 : 0,
      data: whoCanHelp(),
      text: whoCanHelp(),
    };
  }

  const level = parsePermissionLevel(values.level);
  const loaded = loadForCli(values.config ?? './airlock.yaml');
  if ('result' in loaded) return loaded.result(values.json);

  const query = positionals[0];
  const agents = whoCan(loaded.config, query, level);

  const payload = { query, level, agents };
  return {
    json: values.json,
    exitCode: 0,
    data: payload,
    text: formatWhoCan(payload),
  };
}

export function whoCan(
  config: Config,
  query: string,
  level: PermissionLevel = 'any'
): {
  agent: string;
  decision: DetailedDecision;
  match?: { pattern: string };
}[] {
  const engine = new AllowlistEngine(config.agents);
  return Object.keys(config.agents)
    .map((agent) => ({ agent, ...engine.evaluateDetailed(agent, query) }))
    .filter(
      (entry) =>
        level === 'any' ||
        entry.decision === level ||
        (level === 'deny' && entry.decision === 'default-deny')
    );
}

async function toolsCommand(argv: string[]): Promise<CliResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      provider: { type: 'string' },
      grep: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return ok(toolsHelp(), values.json);

  const grep = values.grep ? new RegExp(values.grep, 'i') : undefined;
  const discovered = await discoverTools(values.config ?? './airlock.yaml');
  const tools = discovered.tools
    .filter((tool) => !values.provider || tool.provider === values.provider)
    .filter((tool) => !grep || grep.test(tool.name) || grep.test(tool.description))
    .map((tool) => ({
      name: tool.name,
      provider: tool.provider,
      description: firstLine(tool.description),
    }));
  const payload = { tools, errors: discovered.errors };

  return {
    json: values.json,
    exitCode: discovered.errors.length > 0 ? 1 : 0,
    data: payload,
    text: formatTools(payload),
  };
}

export async function lintCommand(argv: string[]): Promise<CliResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      verbose: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      'fail-on': { type: 'string', default: 'warn' },
      only: { type: 'string', multiple: true },
      disable: { type: 'string', multiple: true },
      rule: { type: 'string', multiple: true },
      'with-catalog': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return ok(lintHelp(), values.json);

  const failOn = parseLintFailLevel(values['fail-on']);
  const loaded = loadConfigDetailed(values.config ?? './airlock.yaml', { resolveEnv: false });
  if (!loaded.config || !loaded.rawConfig) {
    return {
      json: values.json,
      exitCode: 1,
      data: { ok: false, diagnostics: groupDiagnostics(loaded.diagnostics) },
      text: formatCheck({ ok: false, diagnostics: groupDiagnostics(loaded.diagnostics) }),
    };
  }

  const unresolvableDiagnostics = loaded.diagnostics.filter(isUnresolvableRefDiagnostic);
  const fatalDiagnostics = loaded.diagnostics.filter(
    (diagnostic) => diagnostic.level === 'error' && !isUnresolvableRefDiagnostic(diagnostic)
  );
  if (fatalDiagnostics.length > 0) {
    return {
      json: values.json,
      exitCode: 1,
      data: { ok: false, diagnostics: groupDiagnostics(fatalDiagnostics) },
      text: formatCheck({ ok: false, diagnostics: groupDiagnostics(fatalDiagnostics) }),
    };
  }

  const controls = buildLintControls(loaded.rawConfig.lint, {
    only: values.only,
    disable: values.disable,
    rule: values.rule,
  });
  const resolvedConfig = unresolvableDiagnostics.length === 0 ? loaded.config : undefined;
  // Catalog rules are opt-in because they CONNECT to every provider. Default lint stays offline so
  // it remains usable in CI, on a laptop, and against a config whose providers aren't running.
  const catalogFindings =
    values['with-catalog'] && resolvedConfig
      ? lintCatalog(resolvedConfig, await fetchLiveCatalog(values.config ?? './airlock.yaml'))
      : [];
  const findings = applyLintControls(
    [
      ...unresolvableDiagnostics.map(lintFindingFromDiagnostic),
      ...lintConfig(loaded.rawConfig, resolvedConfig),
      ...catalogFindings,
    ],
    controls
  );
  const rules = groupLintFindings(findings);
  const payload = { ok: !shouldFailLint(rules, failOn), failOn, rules };
  return {
    json: values.json,
    exitCode: payload.ok ? 0 : 1,
    data: values.json ? rules : payload,
    text: formatLint(payload, { verbose: values.verbose, quiet: values.quiet }),
  };
}

/**
 * The live tool catalog, as `provider/tool` names grouped by provider. Absent providers (down,
 * unreachable, disabled) must simply not appear — every catalog-aware rule below is scoped to
 * providers we actually heard from, so an outage can never be mistaken for drift.
 */
export type LiveCatalog = Map<string, Set<string>>;

/**
 * Connect to every configured provider and record what it serves, as `provider/tool`.
 *
 * Providers that fail to answer are simply absent from the map — never present-but-empty. The
 * catalog rules key off presence, so an unreachable provider produces silence rather than a flood
 * of "this tool no longer exists" findings about a provider that is merely asleep.
 */
export async function fetchLiveCatalog(configPath: string): Promise<LiveCatalog> {
  const discovered = await discoverTools(configPath);
  const catalog: LiveCatalog = new Map();
  for (const tool of discovered.tools) {
    const existing = catalog.get(tool.provider);
    if (existing) existing.add(tool.name);
    else catalog.set(tool.provider, new Set([tool.name]));
  }
  return catalog;
}

/**
 * Rules that compare config against what providers ACTUALLY serve. Split out from lintConfig
 * because they need the network: the rest of lint is offline and must stay that way for CI.
 *
 * These exist because of a real incident (2026-07-20): a sidecar image sat 9 days behind its
 * source, so a tool present in the repo was served by nothing while a tool that WAS served had
 * silently lost two parameters. Config was valid, the provider was healthy, and every existing
 * check was green. Drift lives in the gap between what a provider offers and what policy names.
 */
export function lintCatalog(resolvedConfig: Config, catalog: LiveCatalog): LintFinding[] {
  const findings: LintFinding[] = [];
  const agents = Object.entries(resolvedConfig.agents);

  // unallocated-tool — the provider serves it, but no agent's allow/ask reaches it. Not an error:
  // default-deny means this is SAFE, and plenty of tools are deliberately ungranted. It is
  // reported because an unreachable tool is invisible to MCP introspection, so a capability you
  // meant to grant looks identical to one you meant to withhold.
  for (const [providerId, toolNames] of catalog) {
    for (const toolName of toolNames) {
      const reachable = agents.some(([, agent]) =>
        [...agent.allow, ...agent.ask].some((pattern) => matches(pattern, toolName))
      );
      if (!reachable) {
        findings.push({
          rule: 'unallocated-tool',
          severity: DEFAULT_LINT_SEVERITY['unallocated-tool'],
          message: `${toolName} is served by provider "${providerId}" but no agent can reach it.`,
          example: toolName,
        });
      }
    }
  }

  // dead-allow — policy names a tool that no longer exists. Wildcards are skipped (a pattern that
  // matches nothing today may match tomorrow's tool, which is the point of a wildcard), and so are
  // providers missing from the catalog entirely: a provider that failed to connect would otherwise
  // report its whole grant surface as dead, which is exactly the false alarm that trains people to
  // ignore a linter.
  const seenDeadGrants = new Set<string>();
  for (const [agentName, agent] of agents) {
    for (const pattern of [...agent.allow, ...agent.ask]) {
      if (pattern.includes('*')) continue;
      const providerId = pattern.split('/')[0];
      const served = catalog.get(providerId);
      if (!served || served.has(pattern)) continue;
      const key = `${agentName}\0${pattern}`;
      if (seenDeadGrants.has(key)) continue;
      seenDeadGrants.add(key);
      findings.push({
        rule: 'dead-allow',
        severity: DEFAULT_LINT_SEVERITY['dead-allow'],
        agent: agentName,
        message: `grants "${pattern}", which provider "${providerId}" does not serve.`,
        example: `[${agentName}] ${pattern}`,
      });
    }
  }

  return findings;
}

export function lintConfig(rawConfig: Config, resolvedConfig?: Config): LintFinding[] {
  const findings: LintFinding[] = [];
  const reachableProfiles = new Set<string>();
  const referencedValueSets = new Set<string>();
  const referencedDimensions = new Set<string>();

  function visitProfile(profileName: string): void {
    if (reachableProfiles.has(profileName)) return;
    const profile = rawConfig.profiles[profileName];
    if (!profile) return;
    reachableProfiles.add(profileName);
    for (const parentName of profile.extends) visitProfile(parentName);
  }

  for (const agent of Object.values(rawConfig.agents)) {
    for (const profileName of agent.extends) visitProfile(profileName);
    collectArgRefs(agent.arg_scope, agent.arg_policy, referencedDimensions, referencedValueSets);
  }

  for (const profile of Object.values(rawConfig.profiles)) {
    collectArgRefs(
      profile.arg_scope,
      profile.arg_policy,
      referencedDimensions,
      referencedValueSets
    );
  }

  for (const profileName of Object.keys(rawConfig.profiles)) {
    if (!reachableProfiles.has(profileName)) {
      findings.push({
        rule: 'unused-profile',
        severity: DEFAULT_LINT_SEVERITY['unused-profile'],
        message: `profiles.${profileName} is not referenced by any agent.`,
        example: profileName,
      });
    }
  }

  for (const valueSetName of Object.keys(rawConfig.value_sets)) {
    if (!referencedValueSets.has(valueSetName)) {
      findings.push({
        rule: 'unused-value-set',
        severity: DEFAULT_LINT_SEVERITY['unused-value-set'],
        message: `value_sets.${valueSetName} is not referenced.`,
        example: valueSetName,
      });
    }
  }

  for (const dimensionName of Object.keys(rawConfig.arg_dimensions)) {
    if (!referencedDimensions.has(dimensionName)) {
      findings.push({
        rule: 'unused-dimension',
        severity: DEFAULT_LINT_SEVERITY['unused-dimension'],
        message: `arg_dimensions.${dimensionName} is not referenced by any arg_scope.`,
        example: dimensionName,
      });
    }
  }

  for (const [agentName, agent] of Object.entries(resolvedConfig?.agents ?? {})) {
    if (agent.allow.length === 0 && agent.ask.length === 0) {
      findings.push({
        rule: 'empty-agent',
        severity: DEFAULT_LINT_SEVERITY['empty-agent'],
        agent: agentName,
        message: 'Agent has an empty effective allow/ask surface.',
        example: `[${agentName}]`,
      });
    }

    for (const denyPattern of agent.deny) {
      const overlapsGrant = [...agent.allow, ...agent.ask].some((pattern) =>
        staticPatternsOverlap(pattern, denyPattern)
      );
      if (!overlapsGrant) {
        findings.push({
          rule: 'dead-deny',
          severity: DEFAULT_LINT_SEVERITY['dead-deny'],
          agent: agentName,
          message: `deny pattern "${denyPattern}" does not overlap any allow or ask pattern.`,
          example: `[${agentName}] ${denyPattern}`,
        });
      }
    }
  }

  for (const envRef of missingEnvRefs(rawConfig)) {
    findings.push({
      rule: 'missing-env-ref',
      severity: DEFAULT_LINT_SEVERITY['missing-env-ref'],
      message: `Environment variable ${envRef} is referenced but not set.`,
      example: `\${${envRef}}`,
    });
  }

  return findings;
}

function collectArgRefs(
  argScope: Record<string, string[]> | undefined,
  argPolicy: Config['agents'][string]['arg_policy'],
  dimensions: Set<string>,
  valueSets: Set<string>
): void {
  for (const [dimensionName, valueSetNames] of Object.entries(argScope ?? {})) {
    dimensions.add(dimensionName);
    for (const valueSetName of valueSetNames) valueSets.add(valueSetName);
  }

  for (const toolPolicy of Object.values(argPolicy ?? {})) {
    for (const constraints of Object.values(toolPolicy)) {
      for (const constraint of constraints) {
        const valueSetName = constraint.in ?? constraint.glob_in ?? constraint.each_in;
        if (valueSetName) valueSets.add(valueSetName);
      }
    }
  }
}

function buildLintControls(
  config: Config['lint'],
  values: {
    only?: string | string[];
    disable?: string | string[];
    rule?: string | string[];
  }
): LintControls {
  const activeRules = new Set<LintRuleId>(LINT_RULE_IDS);
  const severity: Record<LintRuleId, LintRuleSeverity> = { ...DEFAULT_LINT_SEVERITY };

  for (const rule of config.disable) activeRules.delete(rule);

  for (const [rule, level] of Object.entries(config.severity) as [LintRuleId, LintRuleSeverity][]) {
    severity[rule] = level;
  }

  const only = parseRuleIdList(values.only, '--only');
  if (only.length > 0) {
    activeRules.clear();
    for (const rule of only) activeRules.add(rule);
  }

  for (const rule of parseRuleIdList(values.disable, '--disable')) {
    activeRules.delete(rule);
  }

  for (const { rule, mode } of parseRuleOverrides(values.rule)) {
    if (mode === 'off') {
      activeRules.delete(rule);
    } else {
      activeRules.add(rule);
      severity[rule] = mode;
    }
  }

  return { activeRules, severity };
}

function applyLintControls(findings: LintFinding[], controls: LintControls): LintFinding[] {
  return findings.flatMap((finding) => {
    if (!controls.activeRules.has(finding.rule)) return [];
    return [{ ...finding, severity: controls.severity[finding.rule] }];
  });
}

function parseRuleIdList(value: string | string[] | undefined, flag: string): LintRuleId[] {
  return stringOptionValues(value)
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseLintRuleId(entry, flag));
}

function parseRuleOverrides(
  value: string | string[] | undefined
): { rule: LintRuleId; mode: LintRuleMode }[] {
  return stringOptionValues(value)
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [rawRule, rawMode, ...extra] = entry.split('=');
      if (!rawRule || !rawMode || extra.length > 0) {
        throw new Error('--rule must be formatted as <id>=off|info|warn|error.');
      }
      return {
        rule: parseLintRuleId(rawRule, '--rule'),
        mode: parseLintRuleMode(rawMode),
      };
    });
}

function stringOptionValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseLintRuleId(value: string, flag: string): LintRuleId {
  if ((LINT_RULE_IDS as readonly string[]).includes(value)) return value as LintRuleId;
  throw new Error(
    `${flag} references unknown lint rule "${value}". Valid rules: ${LINT_RULE_IDS.join(', ')}.`
  );
}

function parseLintRuleMode(value: string): LintRuleMode {
  if (value === 'off' || value === 'info' || value === 'warn' || value === 'error') return value;
  throw new Error('--rule severity must be off, info, warn, or error.');
}

function parseLintFailLevel(value: unknown): LintRuleSeverity {
  if (value === 'info' || value === 'warn' || value === 'error') return value;
  throw new Error('--fail-on must be info, warn, or error.');
}

function lintFindingFromDiagnostic(diagnostic: ConfigDiagnostic): LintFinding {
  return {
    rule: 'unresolvable-ref',
    severity: DEFAULT_LINT_SEVERITY['unresolvable-ref'],
    agent: diagnostic.agent,
    message: diagnostic.message,
    suggestion: diagnostic.suggestion,
    example: diagnostic.agent ? `[${diagnostic.agent}] ${diagnostic.message}` : diagnostic.message,
  };
}

function isUnresolvableRefDiagnostic(diagnostic: ConfigDiagnostic): boolean {
  return (
    diagnostic.level === 'error' &&
    (diagnostic.code === 'unknown-profile-ref' ||
      diagnostic.code === 'unknown-arg-dimension-ref' ||
      diagnostic.code === 'unknown-value-set-ref')
  );
}

function groupLintFindings(findings: LintFinding[]): LintRuleGroup[] {
  const byRule = new Map<LintRuleId, LintFinding[]>();
  for (const finding of findings) {
    const entries = byRule.get(finding.rule) ?? [];
    entries.push(finding);
    byRule.set(finding.rule, entries);
  }

  return Array.from(byRule.entries())
    .map(([rule, entries]) => ({
      rule,
      severity: entries[0]?.severity ?? DEFAULT_LINT_SEVERITY[rule],
      count: entries.length,
      findings: entries,
    }))
    .sort((a, b) => {
      const severityDelta = severityRank(b.severity) - severityRank(a.severity);
      if (severityDelta !== 0) return severityDelta;
      return LINT_RULE_IDS.indexOf(a.rule) - LINT_RULE_IDS.indexOf(b.rule);
    });
}

interface CliResult {
  json: boolean;
  exitCode: number;
  data: unknown;
  text: string;
}

function loadForCli(
  path: string,
  options: { strict?: boolean } = {}
): LoadedForCli | { result: (json: boolean) => CliResult } {
  const loaded = loadConfigDetailed(path, options);
  const errors = loaded.diagnostics.filter((diagnostic) => diagnostic.level === 'error');
  if (errors.length > 0 || !loaded.config || !loaded.rawConfig) {
    return {
      result: (json) => ({
        json,
        exitCode: 1,
        data: { ok: false, diagnostics: groupDiagnostics(loaded.diagnostics) },
        text: formatCheck({ ok: false, diagnostics: groupDiagnostics(loaded.diagnostics) }),
      }),
    };
  }
  return { config: loaded.config, rawConfig: loaded.rawConfig, diagnostics: loaded.diagnostics };
}

function parseCheckFailLevel(value: unknown): CheckFailLevel {
  if (value === 'warn' || value === 'error') return value;
  throw new Error('--fail-on must be "warn" or "error".');
}

function parsePermissionLevel(value: unknown): PermissionLevel {
  if (value === 'allow' || value === 'ask' || value === 'deny' || value === 'any') return value;
  throw new Error('--level must be allow, ask, deny, or any.');
}

function shouldFail(diagnostics: ConfigDiagnostic[], failOn: CheckFailLevel): boolean {
  return diagnostics.some((diagnostic) =>
    failOn === 'warn'
      ? diagnostic.level === 'warn' || diagnostic.level === 'error'
      : diagnostic.level === 'error'
  );
}

function shouldFailLint(groups: LintRuleGroup[], failOn: LintRuleSeverity): boolean {
  const threshold = severityRank(failOn);
  return groups.some((group) => severityRank(group.severity) >= threshold);
}

function severityRank(severity: LintRuleSeverity): number {
  return severity === 'error' ? 2 : severity === 'warn' ? 1 : 0;
}

function groupDiagnostics(diagnostics: ConfigDiagnostic[]): Record<string, ConfigDiagnostic[]> {
  return {
    error: diagnostics.filter((diagnostic) => diagnostic.level === 'error'),
    warn: diagnostics.filter((diagnostic) => diagnostic.level === 'warn'),
    info: diagnostics.filter((diagnostic) => diagnostic.level === 'info'),
  };
}

function precedenceNotes(explanation: AgentPermissionExplanation): string[] {
  const notes: string[] = [];
  for (const denied of explanation.permissions.deny) {
    for (const allowed of [...explanation.permissions.allow, ...explanation.permissions.ask]) {
      if (staticPatternsOverlap(denied.pattern, allowed.pattern)) {
        notes.push(
          `${denied.pattern} denies overlap ${allowed.pattern}; deny wins when specificity ties or beats the grant.`
        );
      }
    }
  }
  return notes;
}

async function expandedDecisions(
  configPath: string,
  explanation: AgentPermissionExplanation,
  engine: AllowlistEngine
): Promise<{
  tools: { name: string; decision: DetailedDecision; pattern?: string }[];
  errors: string[];
}> {
  const discovered = await discoverTools(configPath);
  const allPatterns = [
    ...explanation.permissions.allow,
    ...explanation.permissions.ask,
    ...explanation.permissions.deny,
  ].map((entry) => entry.pattern);
  const tools = discovered.tools
    .filter((tool) => allPatterns.some((pattern) => matches(pattern, tool.name)))
    .map((tool) => {
      const decision = engine.evaluateDetailed(explanation.agent, tool.name);
      return {
        name: tool.name,
        decision: decision.decision,
        pattern: decision.match?.pattern,
      };
    });
  return { tools, errors: discovered.errors };
}

function formatCheck(payload: {
  ok: boolean;
  diagnostics: Record<string, ConfigDiagnostic[]>;
}): string {
  const lines = [payload.ok ? 'Config OK' : 'Config has problems'];
  for (const level of ['error', 'warn', 'info'] as const) {
    const diagnostics = payload.diagnostics[level];
    if (diagnostics.length === 0) continue;
    lines.push(`${level.toUpperCase()} (${diagnostics.length})`);
    for (const diagnostic of diagnostics) {
      const agent = diagnostic.agent ? `[${diagnostic.agent}] ` : '';
      lines.push(`  - ${agent}${diagnostic.message}`);
      if (diagnostic.suggestion) lines.push(`    ${diagnostic.suggestion}`);
    }
  }
  return lines.join('\n');
}

function formatLint(
  payload: { ok: boolean; failOn: LintRuleSeverity; rules: LintRuleGroup[] },
  options: { verbose: boolean; quiet: boolean }
): string {
  const hiddenInfoCount = options.quiet
    ? payload.rules
        .filter((group) => group.severity === 'info')
        .reduce((total, group) => total + group.count, 0)
    : 0;
  const suffix = hiddenInfoCount > 0 ? ` (${hiddenInfoCount} info hidden)` : '';
  const lines = [payload.ok ? `Lint OK${suffix}` : `Lint has problems${suffix}`];
  let collapsedInfoCount = 0;

  for (const group of payload.rules) {
    if (options.quiet && group.severity === 'info') continue;

    if (group.severity === 'info' && !options.verbose) {
      collapsedInfoCount += group.count;
      lines.push(formatLintInfoSummary(group));
      continue;
    }

    lines.push(`${group.rule}: ${group.count} (${group.severity})`);
    for (const finding of group.findings) {
      const agent = finding.agent ? `[${finding.agent}] ` : '';
      lines.push(`  - ${agent}${finding.message}`);
      if (finding.suggestion) lines.push(`    ${finding.suggestion}`);
    }
  }

  if (collapsedInfoCount > 0) {
    lines.push(`info collapsed; --verbose to list all; --quiet to hide; --fail-on info to gate.`);
  }

  return lines.join('\n');
}

function formatLintInfoSummary(group: LintRuleGroup): string {
  const examples = group.findings.slice(0, 3).map((finding) => finding.example);
  const more = group.count > examples.length ? ` ... +${group.count - examples.length} more` : '';
  return `${group.rule}: ${group.count} (${group.severity}) - ${examples.join(', ')}${more}`;
}

function formatExplain(payload: {
  agent: string;
  explanation: AgentPermissionExplanation;
  precedence: string[];
  expanded?: {
    tools: { name: string; decision: DetailedDecision; pattern?: string }[];
    errors: string[];
  };
}): string {
  const lines = [
    `Agent: ${payload.agent}`,
    'Extends:',
    ...formatTree(payload.explanation.extendsTree),
  ];
  for (const level of ['allow', 'ask', 'deny'] as const) {
    lines.push(`${level.toUpperCase()}:`);
    lines.push(...formatProvenance(payload.explanation.permissions[level]));
  }
  if (payload.explanation.argScope.length > 0) {
    lines.push('ARG SCOPE:');
    for (const scope of payload.explanation.argScope) {
      lines.push(`  ${scope.dimension}: ${scope.valueSets.map((set) => set.name).join(', ')}`);
      for (const binding of scope.bindings) {
        lines.push(`    ${binding.tool}.${binding.arg}`);
      }
    }
  }
  if (payload.precedence.length > 0) {
    lines.push('PRECEDENCE:');
    lines.push(...payload.precedence.map((note) => `  - ${note}`));
  }
  if (payload.expanded) {
    lines.push('EXPANDED TOOLS:');
    lines.push(
      ...payload.expanded.tools.map(
        (tool) => `  - ${tool.name}: ${tool.decision}${tool.pattern ? ` via ${tool.pattern}` : ''}`
      )
    );
    for (const error of payload.expanded.errors) lines.push(`  ! ${error}`);
  }
  return lines.join('\n');
}

function formatProvenance(entries: PermissionWithProvenance[]): string[] {
  if (entries.length === 0) return ['  (none)'];
  return entries.map(
    (entry) => `  - ${entry.pattern} (${entry.sources.map((source) => source.source).join(', ')})`
  );
}

function formatTree(nodes: AgentPermissionExplanation['extendsTree'], indent = '  '): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${indent}- ${node.kind}:${node.name}`);
    lines.push(...formatTree(node.extends, `${indent}  `));
  }
  return lines;
}

function formatWhoCan(payload: {
  query: string;
  level: PermissionLevel;
  agents: { agent: string; decision: DetailedDecision; match?: { pattern: string } }[];
}): string {
  const lines = [`Tool: ${payload.query}`];
  for (const agent of payload.agents) {
    lines.push(
      `  - ${agent.agent}: ${agent.decision}${agent.match ? ` via ${agent.match.pattern}` : ''}`
    );
  }
  if (payload.agents.length === 0) lines.push('  (none)');
  return lines.join('\n');
}

function formatTools(payload: {
  tools: { name: string; description: string }[];
  errors: string[];
}): string {
  const lines = payload.tools.map(
    (tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`
  );
  for (const error of payload.errors) lines.push(`! ${error}`);
  return lines.length > 0 ? lines.join('\n') : '(no tools)';
}

function writeResult(result: CliResult, exitCode: number): void {
  if (result.json) {
    console.log(JSON.stringify(result.data, null, 2));
  } else if (exitCode === 0) {
    console.log(result.text);
  } else {
    console.error(result.text);
  }
  process.exit(exitCode);
}

function ok(text: string, json = false): CliResult {
  return { json, exitCode: 0, data: text, text };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? '';
}

function staticPatternsOverlap(a: string, b: string): boolean {
  return (
    matches(a, b) ||
    matches(b, a) ||
    (a.split('/')[0] === b.split('/')[0] && (a.includes('*') || b.includes('*')))
  );
}

function missingEnvRefs(value: unknown): string[] {
  const refs = new Set<string>();
  walk(value);
  return Array.from(refs).filter((name) => process.env[name] === undefined);

  function walk(next: unknown): void {
    if (typeof next === 'string') {
      for (const match of next.matchAll(/\$\{([^}]+)\}/g)) refs.add(match[1]);
    } else if (Array.isArray(next)) {
      for (const item of next) walk(item);
    } else if (next && typeof next === 'object') {
      for (const item of Object.values(next)) walk(item);
    }
  }
}

function printHelp(): void {
  console.log(`airlock local introspection

Usage:
  airlock config check [--config PATH] [--strict] [--no-resolve] [--fail-on warn|error] [--json]
  airlock explain <agent> [--config PATH] [--expand] [--json]
  airlock who-can <tool-or-glob> [--config PATH] [--level allow|ask|deny|any] [--json]
  airlock tools [--provider NAME] [--grep REGEX] [--config PATH] [--json]
  airlock lint [--config PATH] [--verbose] [--quiet] [--fail-on info|warn|error] [--only IDS] [--disable IDS] [--rule ID=LEVEL] [--json]`);
}

function configCheckHelp(): string {
  return 'Run static config validation. --strict makes unknown keys errors. --no-resolve treats ${VAR} references as structurally satisfied. --fail-on controls the non-zero threshold.';
}

function explainHelp(): string {
  return 'Explain one agent effective permissions, provenance, arg_scope, and precedence. --expand connects to providers.';
}

function whoCanHelp(): string {
  return 'Reverse lookup effective permission decisions for a concrete tool name or glob-like pattern.';
}

function toolsHelp(): string {
  return 'Enumerate the live provider tool surface. This command connects to configured providers.';
}

function lintHelp(): string {
  const rules = LINT_RULE_IDS.map(
    (rule) => `  ${rule} (${DEFAULT_LINT_SEVERITY[rule]}) - ${LINT_RULE_LABELS[rule]}`
  ).join('\n');
  return `Run static hygiene rules over a config. Offline by default; --with-catalog also compares
policy against what providers ACTUALLY serve.

Rules:
${rules}

unallocated-tool and dead-allow require --with-catalog; without it they never fire.

Default output prints warn/error findings in full and collapses each info rule to one summary line.

Options:
  --verbose                    Expand info findings too
  --quiet                      Hide info summaries and print warn/error findings only
  --fail-on info|warn|error    Non-zero threshold (default: warn)
  --only ids                   Run only comma-separated rule ids
  --disable ids                Disable comma-separated rule ids for this invocation
  --rule id=off|info|warn|error
                               Override a rule severity for this invocation
  --with-catalog               Connect to providers and check policy against the live tool list.
                               Finds tools nobody can reach, and grants naming tools that are gone.
                               Providers that fail to answer are skipped, never reported as empty.
  --json                       Print grouped machine-readable findings`;
}
