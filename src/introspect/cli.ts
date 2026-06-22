import { parseArgs } from 'util';
import { AllowlistEngine, type DetailedDecision } from '../allowlist/engine.js';
import { matches } from '../allowlist/pattern.js';
import { loadConfigDetailed, type Config, type ConfigDiagnostic } from '../config/loader.js';
import {
  explainAgentPermissions,
  type AgentPermissionExplanation,
  type PermissionWithProvenance,
} from '../config/profiles.js';
import { discoverTools } from '../configure-web/cli.js';

type FailLevel = 'warn' | 'error';
type PermissionLevel = 'allow' | 'ask' | 'deny' | 'any';

interface LoadedForCli {
  config: Config;
  rawConfig: Config;
  diagnostics: ConfigDiagnostic[];
}

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
    const result = lintCommand(argv.slice(1));
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

  const failOn = parseFailLevel(values['fail-on']);
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

function lintCommand(argv: string[]): CliResult {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return ok(lintHelp(), values.json);

  const loaded = loadForCli(values.config ?? './airlock.yaml', { strict: values.strict });
  if ('result' in loaded) return loaded.result(values.json);

  const diagnostics = lintConfig(loaded.rawConfig, loaded.config);
  const payload = { ok: diagnostics.length === 0, diagnostics: groupDiagnostics(diagnostics) };
  return {
    json: values.json,
    exitCode: values.strict && diagnostics.length > 0 ? 1 : 0,
    data: payload,
    text: formatCheck(payload),
  };
}

export function lintConfig(rawConfig: Config, resolvedConfig: Config): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
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
      diagnostics.push({
        level: 'warn',
        message: `profiles.${profileName} is not referenced by any agent.`,
      });
    }
  }

  for (const valueSetName of Object.keys(rawConfig.value_sets)) {
    if (!referencedValueSets.has(valueSetName)) {
      diagnostics.push({ level: 'warn', message: `value_sets.${valueSetName} is not referenced.` });
    }
  }

  for (const dimensionName of Object.keys(rawConfig.arg_dimensions)) {
    if (!referencedDimensions.has(dimensionName)) {
      diagnostics.push({
        level: 'warn',
        message: `arg_dimensions.${dimensionName} is not referenced by any arg_scope.`,
      });
    }
  }

  for (const [agentName, agent] of Object.entries(resolvedConfig.agents)) {
    if (agent.allow.length === 0 && agent.ask.length === 0) {
      diagnostics.push({
        level: 'warn',
        agent: agentName,
        message: 'Agent has an empty effective allow/ask surface.',
      });
    }

    for (const denyPattern of agent.deny) {
      const overlapsGrant = [...agent.allow, ...agent.ask].some((pattern) =>
        staticPatternsOverlap(pattern, denyPattern)
      );
      if (!overlapsGrant) {
        diagnostics.push({
          level: 'warn',
          agent: agentName,
          message: `deny pattern "${denyPattern}" does not overlap any allow or ask pattern.`,
        });
      }
    }
  }

  for (const envRef of missingEnvRefs(rawConfig)) {
    diagnostics.push({
      level: 'warn',
      message: `Environment variable ${envRef} is referenced but not set.`,
    });
  }

  return diagnostics;
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

function parseFailLevel(value: unknown): FailLevel {
  if (value === 'warn' || value === 'error') return value;
  throw new Error('--fail-on must be "warn" or "error".');
}

function parsePermissionLevel(value: unknown): PermissionLevel {
  if (value === 'allow' || value === 'ask' || value === 'deny' || value === 'any') return value;
  throw new Error('--level must be allow, ask, deny, or any.');
}

function shouldFail(diagnostics: ConfigDiagnostic[], failOn: FailLevel): boolean {
  return diagnostics.some((diagnostic) =>
    failOn === 'warn'
      ? diagnostic.level === 'warn' || diagnostic.level === 'error'
      : diagnostic.level === 'error'
  );
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
  airlock lint [--config PATH] [--strict] [--json]`);
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
  return 'Run static hygiene warnings over a valid resolved config.';
}
