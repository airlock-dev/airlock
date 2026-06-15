import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { parseArgs } from 'util';
import Fastify from 'fastify';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { buildAdapters } from '../backend/factory.js';
import {
  GatewayConfig,
  getMcpConfigs,
  type GatewayConfig as ParsedGatewayConfig,
} from '../config/schema.js';
import { validateConfig, type ConfigDiagnostic } from '../config/loader.js';
import { ClientPool } from '../pool/pool.js';
import { checkSuspiciousPatterns } from '../registry/sanitizer.js';

type PermissionKind = 'agent' | 'profile';
type RecommendedDecision = 'allow' | 'ask' | 'deny';

interface WebState {
  configPath: string;
  providers: Record<string, EditableProvider>;
  agents: Record<string, EditableAgent>;
  profiles: Record<string, EditableProfile>;
  diagnostics: ConfigDiagnostic[];
}

interface EditableProvider {
  type: 'builtin' | 'stdio' | 'sse' | 'http';
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  oauth?: boolean;
}

interface EditableAgent {
  extends: string[];
  allow: string[];
  ask: string[];
  deny: string[];
}

interface EditableProfile {
  allow: string[];
  ask: string[];
  deny: string[];
}

interface SaveRulesBody {
  kind?: PermissionKind;
  id?: string;
  extends?: unknown;
  allow?: unknown;
  ask?: unknown;
  deny?: unknown;
}

interface EntityBody {
  kind?: PermissionKind;
  id?: string;
  baseId?: string;
}

interface ProviderBody {
  id?: string;
  type?: string;
  enabled?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  oauth?: unknown;
}

interface ToolEntry {
  name: string;
  provider: string;
  shortName: string;
  description: string;
  annotations: Tool['annotations'];
  tags: string[];
  suspiciousPatterns: string[];
  recommended: RecommendedDecision;
}

type ProviderRuntimeStatus = 'ok' | 'down' | 'disabled';

interface ProviderStatusEntry {
  id: string;
  type: EditableProvider['type'];
  enabled: boolean;
  status: ProviderRuntimeStatus;
  toolCount: number;
  toolFingerprint: string;
  serverInfo?: { name: string; version: string };
  error?: string;
}

interface CommandCenterStatus {
  generatedAt: string;
  providers: ProviderStatusEntry[];
  summary: {
    ok: number;
    down: number;
    disabled: number;
    tools: number;
  };
}

const HELP = `
airlock configure-web - browser UI for profiles, agents, and allow/ask/deny lists

Usage:
  airlock configure-web [options]

Options:
  -c, --config <path>   Airlock config file (default: ./airlock.yaml)
  -p, --port <port>     Web UI port (default: 4177)
      --host <host>     Bind host (default: 127.0.0.1)
  -h, --help            Show this help
`;

const RUN_HELP = `
airlock run - browser command center for provider health and permissions

Usage:
  airlock run [options]

Options:
  -c, --config <path>   Airlock config file (default: ./airlock.yaml)
  -p, --port <port>     Web UI port (default: 4177)
      --host <host>     Bind host (default: 127.0.0.1)
  -h, --help            Show this help
`;

export async function runCommandCenter(argv: string[]): Promise<void> {
  await runConfigureWeb(argv, 'run');
}

export async function runConfigureWeb(
  argv: string[],
  entrypoint: 'configure-web' | 'run' = 'configure-web'
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      port: { type: 'string', short: 'p', default: '4177' },
      host: { type: 'string', default: '127.0.0.1' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(entrypoint === 'run' ? RUN_HELP : HELP);
    process.exit(0);
  }

  const configPath = values.config ?? './airlock.yaml';
  const port = Number(values.port ?? '4177');
  const host = values.host ?? '127.0.0.1';

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }

  const app = createConfigureWebApp(configPath);
  await app.listen({ host, port });
  console.log(`Airlock command center running at http://${host}:${port}`);
  console.log(`Editing ${configPath}`);
}

export function createConfigureWebApp(configPath: string) {
  const app = Fastify({ logger: false });

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(INDEX_HTML);
  });

  app.get('/api/state', () => readState(configPath));

  app.get('/api/status', async (_request, reply) => {
    try {
      return await readCommandCenterStatus(configPath);
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/api/tools', async (_request, reply) => {
    try {
      return await discoverTools(configPath);
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err), tools: [] };
    }
  });

  app.post('/api/rules', async (request, reply) => {
    try {
      const body = request.body as SaveRulesBody;
      return saveRules(configPath, body);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/entities', async (request, reply) => {
    try {
      const body = request.body as EntityBody;
      return createEntity(configPath, body);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/providers', async (request, reply) => {
    try {
      const body = request.body as ProviderBody;
      return upsertProvider(configPath, body);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete('/api/providers/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return deleteProvider(configPath, id);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete('/api/entities/:kind/:id', async (request, reply) => {
    try {
      const { kind, id } = request.params as { kind: PermissionKind; id: string };
      return deleteEntity(configPath, kind, id);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  return app;
}

export function readState(configPath: string): WebState {
  const parsed = readConfigObject(configPath);
  const validation = parseGatewayConfig(parsed);
  const config = validation.config;

  return {
    configPath,
    providers: toEditableProviders(asRecord(parsed.providers)),
    agents: toEditableAgents(asRecord(parsed.agents)),
    profiles: toEditableProfiles(asRecord(parsed.profiles)),
    diagnostics: config ? validateConfig(config) : validation.diagnostics,
  };
}

export async function readCommandCenterStatus(configPath: string): Promise<CommandCenterStatus> {
  const raw = readConfigObject(configPath);
  const editableProviders = toEditableProviders(asRecord(raw.providers));
  const parsed = GatewayConfig.parse(withoutDisabledProviders(raw));
  const mcpConfigs = getMcpConfigs(parsed.providers);
  const statuses = new Map<string, ProviderStatusEntry>();

  for (const [id, provider] of Object.entries(editableProviders)) {
    statuses.set(id, {
      id,
      type: provider.type,
      enabled: provider.enabled,
      status: provider.enabled ? 'down' : 'disabled',
      toolCount: 0,
      toolFingerprint: '',
      error: provider.enabled ? 'Not checked yet' : undefined,
    });
  }

  const pool = new ClientPool(mcpConfigs, {
    stdioStderr: 'ignore',
    healthCheck: false,
    retryFailedConnections: false,
  });

  try {
    await Promise.race([
      pool.initialize(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);

    const adapters = buildAdapters(parsed, pool);
    await Promise.all(
      adapters.map(async (adapter) => {
        const id = adapter.id.startsWith('builtin:')
          ? adapter.id.slice('builtin:'.length)
          : adapter.id.startsWith('mcp:')
            ? adapter.id.slice('mcp:'.length)
            : adapter.id;
        const status = statuses.get(id);
        if (!status) return;

        try {
          const tools = await withTimeout(
            adapter.listTools(),
            3_000,
            `${id}: timed out listing tools`
          );
          status.toolCount = tools.length;
          status.toolFingerprint = toolFingerprint(tools.map((tool) => tool.name));
          status.status = 'ok';
          status.error = undefined;
          const serverInfo = pool.getServerInfo(id);
          if (serverInfo) status.serverInfo = serverInfo;
        } catch (err) {
          status.status = 'down';
          status.error = err instanceof Error ? err.message : String(err);
        }
      })
    );

    for (const [id, mcpConfig] of Object.entries(mcpConfigs)) {
      const status = statuses.get(id);
      if (!status) continue;
      status.type = mcpConfig.type;
      status.serverInfo = pool.getServerInfo(id);
      if (!pool.isReady(id) && !status.error) {
        status.status = 'down';
        status.error = 'MCP provider is not connected';
      }
    }
  } finally {
    await pool.stop().catch(() => {});
  }

  const providers = Array.from(statuses.values()).sort((a, b) => a.id.localeCompare(b.id));
  return {
    generatedAt: new Date().toISOString(),
    providers,
    summary: {
      ok: providers.filter((provider) => provider.status === 'ok').length,
      down: providers.filter((provider) => provider.status === 'down').length,
      disabled: providers.filter((provider) => provider.status === 'disabled').length,
      tools: providers.reduce((sum, provider) => sum + provider.toolCount, 0),
    },
  };
}

export function saveRules(configPath: string, body: SaveRulesBody): WebState {
  const kind = parseKind(body.kind);
  const id = parseId(body.id);
  const doc = readConfigObject(configPath);
  const sectionName = kind === 'agent' ? 'agents' : 'profiles';
  const section = asMutableRecord(doc[sectionName]);
  const existing = asMutableRecord(section[id]);

  if (kind === 'agent') {
    existing.extends = parseStringArray(body.extends, 'extends');
    existing.allow = parseStringArray(body.allow, 'allow');
    existing.ask = parseStringArray(body.ask, 'ask');
    existing.deny = parseStringArray(body.deny, 'deny');
  } else {
    existing.allow = parseStringArray(body.allow, 'allow');
    existing.ask = parseStringArray(body.ask, 'ask');
    existing.deny = parseStringArray(body.deny, 'deny');
  }

  section[id] = existing;
  doc[sectionName] = section;
  writeValidatedConfig(configPath, doc);
  return readState(configPath);
}

export function toolFingerprint(toolNames: string[]): string {
  return toolNames.slice().sort().join('\n');
}

export function createEntity(configPath: string, body: EntityBody): WebState {
  const kind = parseKind(body.kind);
  const id = parseId(body.id);
  const doc = readConfigObject(configPath);
  const sectionName = kind === 'agent' ? 'agents' : 'profiles';
  const section = asMutableRecord(doc[sectionName]);

  if (section[id]) throw new Error(`${kind} "${id}" already exists`);

  if (body.baseId && section[body.baseId]) {
    section[id] = structuredClone(section[body.baseId]);
  } else {
    section[id] = { allow: [], ask: [], deny: [] };
  }

  doc[sectionName] = section;
  writeValidatedConfig(configPath, doc);
  return readState(configPath);
}

export function deleteEntity(configPath: string, kind: PermissionKind, id: string): WebState {
  const parsedKind = parseKind(kind);
  const parsedId = parseId(id);
  const doc = readConfigObject(configPath);
  const sectionName = parsedKind === 'agent' ? 'agents' : 'profiles';
  const section = asMutableRecord(doc[sectionName]);

  if (!section[parsedId]) throw new Error(`${parsedKind} "${parsedId}" does not exist`);
  delete section[parsedId];

  doc[sectionName] = section;
  writeValidatedConfig(configPath, doc);
  return readState(configPath);
}

export function upsertProvider(configPath: string, body: ProviderBody): WebState {
  const id = parseId(body.id);
  const type = parseProviderType(body.type);
  const doc = readConfigObject(configPath);
  const providers = asMutableRecord(doc.providers);
  const existing = asMutableRecord(providers[id]);
  const enabled =
    body.enabled === undefined ? providerEnabled(existing) : parseBoolean(body.enabled);

  if (type === 'builtin') {
    providers[id] = enabled ? 'builtin' : { type: 'builtin', enabled: false };
  } else if (type === 'stdio') {
    const command =
      typeof body.command === 'string' && body.command.trim()
        ? body.command.trim()
        : typeof existing.command === 'string'
          ? existing.command
          : '';
    if (!command) throw new Error('stdio providers require command');
    providers[id] = removeUndefined({
      ...existing,
      type,
      enabled: enabled ? undefined : false,
      command,
      args: parseOptionalStringArray(body.args, 'args') ?? stringArray(existing.args),
    });
  } else {
    const url =
      typeof body.url === 'string' && body.url.trim()
        ? body.url.trim()
        : typeof existing.url === 'string'
          ? existing.url
          : '';
    if (!url) throw new Error(`${type} providers require url`);
    providers[id] = removeUndefined({
      ...existing,
      type,
      enabled: enabled ? undefined : false,
      url,
      oauth:
        type === 'http' ? (parseOptionalBoolean(body.oauth) ?? Boolean(existing.oauth)) : undefined,
    });
  }

  doc.providers = providers;
  writeValidatedConfig(configPath, doc);
  return readState(configPath);
}

export function deleteProvider(configPath: string, id: string): WebState {
  const parsedId = parseId(id);
  const doc = readConfigObject(configPath);
  const providers = asMutableRecord(doc.providers);
  if (!providers[parsedId]) throw new Error(`provider "${parsedId}" does not exist`);
  delete providers[parsedId];
  doc.providers = providers;
  writeValidatedConfig(configPath, doc);
  return readState(configPath);
}

export function recommendedDecision(
  annotations: Tool['annotations'],
  suspiciousPatterns: string[] = []
): RecommendedDecision {
  if (suspiciousPatterns.length > 0) return 'deny';
  if (annotations?.destructiveHint || annotations?.openWorldHint) return 'ask';
  return 'allow';
}

export function annotationTags(
  annotations: Tool['annotations'],
  suspiciousPatterns: string[] = []
): string[] {
  const tags: string[] = [];
  if (annotations?.readOnlyHint) tags.push('readonly');
  if (annotations?.destructiveHint) tags.push('destructive');
  if (annotations?.idempotentHint) tags.push('idempotent');
  if (annotations?.openWorldHint) tags.push('open-world');
  if (suspiciousPatterns.length > 0) tags.push('injection');
  return tags;
}

export async function discoverTools(
  configPath: string
): Promise<{ tools: ToolEntry[]; errors: string[] }> {
  const raw = readConfigObject(configPath);
  const parsed = GatewayConfig.parse(withoutDisabledProviders(raw));
  const mcpConfigs = getMcpConfigs(parsed.providers);
  const pool = new ClientPool(mcpConfigs, {
    stdioStderr: 'ignore',
    healthCheck: false,
    retryFailedConnections: false,
  });
  const errors: string[] = [];

  try {
    await Promise.race([
      pool.initialize(),
      new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
    ]);

    const adapters = buildAdapters(parsed, pool);
    const settled = await Promise.allSettled(
      adapters.map((adapter) =>
        withTimeout(adapter.listTools(), 8_000, `${adapter.id}: timed out listing tools`)
      )
    );
    const tools: ToolEntry[] = [];

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const adapter = adapters[i];
      if (result.status === 'rejected') {
        errors.push(
          `${adapter.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
        continue;
      }
      for (const tool of result.value) {
        const provider = tool.name.split('/')[0] ?? '';
        const suspiciousPatterns = tool.description
          ? checkSuspiciousPatterns(tool.description)
          : [];
        tools.push({
          name: tool.name,
          provider,
          shortName: tool.name.split('/').slice(1).join('/') || tool.name,
          description: tool.description ?? '',
          annotations: tool.annotations,
          tags: annotationTags(tool.annotations, suspiciousPatterns),
          suspiciousPatterns,
          recommended: recommendedDecision(tool.annotations, suspiciousPatterns),
        });
      }
    }

    tools.sort((a, b) => a.name.localeCompare(b.name));
    return { tools, errors };
  } finally {
    await pool.stop().catch(() => {});
  }
}

function withoutDisabledProviders(doc: Record<string, unknown>): Record<string, unknown> {
  const providers = asRecord(doc.providers);
  const enabledProviders = Object.fromEntries(
    Object.entries(providers).filter(([, provider]) => !rawProviderDisabled(provider))
  );
  return { ...doc, providers: enabledProviders };
}

function rawProviderDisabled(provider: unknown): boolean {
  return asRecord(provider).enabled === false;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  const raw = readFileSync(configPath, 'utf8');
  const parsed: unknown = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config must be a YAML object: ${configPath}`);
  }
  return parsed as Record<string, unknown>;
}

function writeValidatedConfig(configPath: string, doc: Record<string, unknown>): void {
  const validation = parseGatewayConfig(doc);
  const errors = validation.diagnostics.filter((d) => d.level === 'error');
  if (!validation.config || errors.length > 0) {
    const message =
      errors.map((d) => `${d.agent ? `[${d.agent}] ` : ''}${d.message}`).join('\n') ||
      'Config did not pass schema validation';
    throw new Error(message);
  }

  const backupPath = configPath.replace(/\.ya?ml$/i, '') + '.bak';
  copyFileSync(configPath, backupPath);
  writeFileSync(configPath, stringifyYaml(doc));
}

function parseGatewayConfig(doc: Record<string, unknown>): {
  config?: ParsedGatewayConfig;
  diagnostics: ConfigDiagnostic[];
} {
  try {
    const result = GatewayConfig.safeParse(doc);
    if (!result.success) {
      return {
        diagnostics: [
          {
            level: 'error',
            message: result.error.issues.map((issue) => issue.message).join('; '),
          },
        ],
      };
    }
    return { config: result.data, diagnostics: validateConfig(result.data) };
  } catch (err) {
    return {
      diagnostics: [{ level: 'error', message: err instanceof Error ? err.message : String(err) }],
    };
  }
}

function toEditableAgents(input: Record<string, unknown>): Record<string, EditableAgent> {
  return Object.fromEntries(
    Object.entries(input).map(([id, value]) => {
      const agent = asRecord(value);
      return [
        id,
        {
          extends: stringArray(agent.extends),
          allow: stringArray(agent.allow),
          ask: stringArray(agent.ask),
          deny: stringArray(agent.deny),
        },
      ];
    })
  );
}

function toEditableProviders(input: Record<string, unknown>): Record<string, EditableProvider> {
  const providers: Record<string, EditableProvider> = {};
  for (const [id, value] of Object.entries(input)) {
    if (value === 'builtin') {
      providers[id] = { type: 'builtin', enabled: true };
      continue;
    }

    const provider = asRecord(value);
    const type = parseProviderType(provider.type);
    providers[id] = {
      type,
      enabled: providerEnabled(provider),
      command: typeof provider.command === 'string' ? provider.command : undefined,
      args: stringArray(provider.args),
      url: typeof provider.url === 'string' ? provider.url : undefined,
      oauth: typeof provider.oauth === 'boolean' ? provider.oauth : undefined,
    };
  }
  return providers;
}

function toEditableProfiles(input: Record<string, unknown>): Record<string, EditableProfile> {
  return Object.fromEntries(
    Object.entries(input).map(([id, value]) => {
      const profile = asRecord(value);
      return [
        id,
        {
          allow: stringArray(profile.allow),
          ask: stringArray(profile.ask),
          deny: stringArray(profile.deny),
        },
      ];
    })
  );
}

function parseProviderType(value: unknown): EditableProvider['type'] {
  if (value === 'builtin' || value === 'stdio' || value === 'sse' || value === 'http') {
    return value;
  }
  throw new Error('provider type must be "builtin", "stdio", "sse", or "http"');
}

function parseKind(value: unknown): PermissionKind {
  if (value === 'agent' || value === 'profile') return value;
  throw new Error('kind must be "agent" or "profile"');
}

function parseId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('id must be a string');
  const id = value.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error('id may only contain letters, numbers, dots, underscores, and dashes');
  }
  return id;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error('enabled must be a boolean');
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  return value === undefined ? undefined : parseBoolean(value);
}

function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings`);
  }

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${name} must be an array of strings`);
    }
    const trimmed = item.trim();
    if (trimmed) result.push(trimmed);
  }

  return dedupe(result);
}

function parseOptionalStringArray(value: unknown, name: string): string[] | undefined {
  return value === undefined ? undefined : parseStringArray(value, name);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  return { ...asRecord(value) };
}

function providerEnabled(provider: Record<string, unknown>): boolean {
  return provider.enabled !== false;
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Airlock Command Center</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #1d2530;
      --muted: #647184;
      --line: #dce2ea;
      --blue: #2457d6;
      --green: #15804d;
      --amber: #946000;
      --red: #b42318;
      --shadow: 0 16px 42px rgba(30, 41, 59, 0.10);
    }
    * { box-sizing: border-box; }
    html {
      height: 100%;
      overflow: hidden;
    }
    body {
      margin: 0;
      height: 100%;
      overflow: hidden;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    button, input, select {
      box-sizing: border-box;
      font: inherit;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--ink);
      cursor: pointer;
      line-height: 1;
      padding: 0 10px;
      vertical-align: middle;
    }
    button:hover { border-color: #aeb9c8; }
    button.primary {
      background: var(--blue);
      color: #fff;
      border-color: var(--blue);
    }
    .app {
      height: 100vh;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    header {
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 20px;
      background: #fff;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0;
    }
    .subtle { color: var(--muted); }
    .top-actions, .row, .entity-actions, .toolbar, .rule-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .layout {
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 300px;
    }
    aside, .details {
      min-height: 0;
      padding: 16px;
      border-right: 1px solid var(--line);
      overflow: auto;
      background: #fbfcfe;
    }
    .details {
      border-right: 0;
      border-left: 1px solid var(--line);
    }
    main {
      min-width: 0;
      min-height: 0;
      padding: 18px;
      overflow: auto;
    }
    .section-title {
      margin: 18px 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.08em;
    }
    .entity {
      width: 100%;
      justify-content: flex-start;
      margin-bottom: 6px;
      background: transparent;
    }
    .entity.active {
      background: #eaf0ff;
      border-color: #b9c8ff;
      color: #173c9c;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
    }
    .status-tile {
      min-width: 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      box-shadow: var(--shadow);
    }
    .status-value {
      font-size: 24px;
      font-weight: 750;
      line-height: 1;
    }
    .status-value.runtime-ok { color: var(--green); }
    .status-value.runtime-down { color: var(--red); }
    .status-value.runtime-disabled { color: var(--muted); }
    .status-label {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .provider-item {
      display: grid;
      grid-template-columns: minmax(170px, 1fr) 94px 82px 82px 64px 64px 64px;
      align-items: center;
      gap: 10px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    .provider-item:last-child {
      border-bottom: 0;
    }
    .provider-name {
      min-width: 0;
      overflow-wrap: anywhere;
      font-size: 13px;
      font-weight: 650;
    }
    .provider-name span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }
    .provider-item.disabled .provider-name {
      color: var(--muted);
      text-decoration: line-through;
    }
    .provider-item button {
      min-width: 34px;
      padding: 0 8px;
    }
    .pill.provider-status-enabled {
      border-color: #b8dfca;
      background: #e8f6ef;
      color: var(--green);
      font-weight: 700;
    }
    .pill.provider-status-disabled {
      border-color: #f2c0bb;
      background: #fff0ee;
      color: var(--red);
      font-weight: 700;
    }
    .pill.runtime-ok {
      border-color: #b8dfca;
      background: #e8f6ef;
      color: var(--green);
      font-weight: 700;
    }
    .pill.runtime-down {
      border-color: #f2c0bb;
      background: #fff0ee;
      color: var(--red);
      font-weight: 700;
    }
    .pill.runtime-disabled {
      border-color: #d7dee8;
      background: #f2f5f8;
      color: var(--muted);
      font-weight: 700;
    }
    .pill.runtime-stale {
      border-color: #f1d99a;
      background: #fff4d6;
      color: var(--amber);
      font-weight: 700;
    }
    .stale-notice {
      padding: 10px 12px;
      border: 1px solid #f1d99a;
      border-radius: 8px;
      background: #fff8e1;
      color: #6a4400;
      font-size: 13px;
      font-weight: 650;
    }
    .provider-list {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .workspace {
      display: grid;
      gap: 14px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .hero h2 {
      margin: 0 0 4px;
      font-size: 24px;
      letter-spacing: 0;
    }
    .toolbar {
      flex-wrap: wrap;
      padding: 12px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .toolbar input, .toolbar select, .details input {
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 0 10px;
      background: #fff;
      color: var(--ink);
    }
    .toolbar input { flex: 1 1 260px; min-width: 180px; }
    .table {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .tool-row {
      display: grid;
      grid-template-columns: minmax(180px, 280px) minmax(0, 1fr) 236px;
      gap: 12px;
      align-items: start;
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    .tool-row:last-child { border-bottom: 0; }
    .tool-name {
      min-width: 0;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .provider {
      display: inline-block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .description {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }
    .description-content {
      position: relative;
      display: grid;
      gap: 7px;
      max-width: 78ch;
      overflow-wrap: anywhere;
    }
    .description-content.collapsed {
      max-height: 4.25rem;
      overflow: hidden;
    }
    .description-content.collapsed::after {
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      height: 28px;
      background: linear-gradient(180deg, rgba(255,255,255,0), var(--panel));
      content: "";
      pointer-events: none;
    }
    .description-content p,
    .description-content h4 {
      margin: 0;
    }
    .description-content h4 {
      color: var(--ink);
      font-size: 13px;
      font-weight: 750;
    }
    .description-content code {
      padding: 1px 4px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #f5f7fb;
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .description-content strong {
      color: var(--ink);
      font-weight: 700;
    }
    .description-step {
      padding-left: 10px;
      border-left: 2px solid var(--line);
    }
    .description-toggle {
      height: 28px;
      margin-top: 8px;
      padding: 0 8px;
      color: #173c9c;
      font-size: 12px;
      font-weight: 650;
      background: #f7f9fd;
    }
    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--muted);
      font-size: 11px;
      line-height: 1;
    }
    .tag-good {
      border-color: #b8dfca;
      background: #e8f6ef;
      color: var(--green);
    }
    .tag-warn {
      border-color: #f1d99a;
      background: #fff4d6;
      color: var(--amber);
    }
    .tag-danger {
      border-color: #f2c0bb;
      background: #fff0ee;
      color: var(--red);
    }
    .tag-recommended {
      border-style: dashed;
      font-weight: 650;
    }
    .rule-actions {
      justify-content: flex-end;
    }
    .rule-actions button {
      width: 52px;
      padding: 0;
    }
    .rule-actions button.active[data-decision="allow"] {
      border-color: var(--green);
      background: #e8f6ef;
      color: var(--green);
      font-weight: 700;
    }
    .rule-actions button.active[data-decision="ask"] {
      border-color: var(--amber);
      background: #fff4d6;
      color: var(--amber);
      font-weight: 700;
    }
    .rule-actions button.active[data-decision="deny"] {
      border-color: var(--red);
      background: #fff0ee;
      color: var(--red);
      font-weight: 700;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: #fff;
      font-size: 12px;
    }
    .stack {
      display: grid;
      gap: 10px;
    }
    .panel {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .panel h3 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    .check {
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 8px 0;
      color: var(--ink);
    }
    .check input { width: 16px; height: 16px; }
    .diagnostic {
      padding: 10px;
      border-radius: 7px;
      background: #fff7e6;
      color: #6a4400;
      font-size: 13px;
      line-height: 1.35;
    }
    .diagnostic.error {
      background: #fff0ee;
      color: var(--red);
    }
    .empty {
      padding: 30px;
      text-align: center;
      color: var(--muted);
    }
    @media (max-width: 1080px) {
      .layout { grid-template-columns: 220px minmax(0, 1fr); }
      .details { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); }
      .status-grid { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .tool-row { grid-template-columns: minmax(160px, 240px) minmax(0, 1fr); }
      .rule-actions { grid-column: 1 / -1; justify-content: flex-start; }
    }
    @media (max-width: 720px) {
      header { height: auto; min-height: 64px; align-items: flex-start; flex-direction: column; padding: 12px; }
      .layout { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .tool-row { grid-template-columns: 1fr; }
      .hero { flex-direction: column; }
      .status-grid { grid-template-columns: 1fr; }
      .provider-item { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div>
        <h1>Airlock Command Center</h1>
        <div id="configPath" class="subtle"></div>
      </div>
      <div class="top-actions">
        <button id="refreshStatus">Refresh Status</button>
        <button id="refreshTools">Refresh Tools</button>
        <button id="saveRules" class="primary">Save</button>
      </div>
    </header>
    <div class="layout">
      <aside>
        <button id="manageProviders" class="entity" style="margin-bottom:14px">Manage Providers</button>
        <div class="row">
          <div class="section-title" style="margin-top:0">Agents</div>
          <button id="addAgent" title="Add agent">+</button>
        </div>
        <div id="agents"></div>
        <div class="row">
          <div class="section-title">Profiles</div>
          <button id="addProfile" title="Add profile">+</button>
        </div>
        <div id="profiles"></div>
      </aside>
      <main>
        <div class="workspace">
          <div class="hero">
            <div>
              <h2 id="activeTitle">Select an agent or profile</h2>
              <div id="activeMeta" class="subtle"></div>
            </div>
            <div class="entity-actions">
              <button id="addProvider" style="display:none">Add Provider</button>
              <button id="deleteEntity">Delete</button>
            </div>
          </div>
          <div id="statusGrid" class="status-grid"></div>
          <div id="staleNotice" class="stale-notice" hidden></div>
          <div class="toolbar">
            <input id="search" type="search" placeholder="Search tools, endpoints, providers">
            <select id="providerFilter"></select>
            <select id="decisionFilter">
              <option value="all">All rules</option>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
              <option value="unset">Unset</option>
            </select>
            <button id="bulkAllow">Allow Visible</button>
            <button id="bulkAsk">Ask Visible</button>
            <button id="bulkDeny">Deny Visible</button>
            <button id="bulkClear">Clear Visible</button>
            <button id="resetRules">Reset Visible</button>
            <button id="recommendedRules">Set Visible Recommended</button>
            <button id="resetAllRules">Reset All to Config</button>
          </div>
          <div id="tools" class="table"></div>
        </div>
      </main>
      <section class="details">
        <div class="stack">
          <div class="panel">
            <h3>Summary</h3>
            <div id="summary" class="stack"></div>
          </div>
          <div class="panel" id="profilePanel">
            <h3>Inherited Profiles</h3>
            <div id="profileChecks"></div>
          </div>
          <div class="panel">
            <h3>Diagnostics</h3>
            <div id="diagnostics" class="stack"></div>
          </div>
        </div>
      </section>
    </div>
  </div>
  <script>
    const state = {
      config: null,
      status: null,
      tools: [],
      toolsLoaded: false,
      errors: [],
      activeKind: 'agent',
      activeId: '',
      drafts: {},
      descriptionExpanded: {},
      search: '',
      provider: 'all',
      decision: 'all'
    };

    const el = (id) => document.getElementById(id);
    const keyFor = (kind, id) => kind + ':' + id;

    async function api(path, options) {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...options
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      return body;
    }

    async function loadState() {
      state.config = await api('/api/state');
      el('configPath').textContent = state.config.configPath;
      if (!state.activeId) {
        const firstAgent = Object.keys(state.config.agents)[0];
        const firstProfile = Object.keys(state.config.profiles)[0];
        if (firstAgent) setActive('agent', firstAgent);
        else if (firstProfile) setActive('profile', firstProfile);
      }
      hydrateDrafts();
      render();
    }

    async function refreshTools() {
      el('refreshTools').disabled = true;
      el('refreshTools').textContent = 'Refreshing...';
      try {
        const result = await api('/api/tools');
        state.tools = result.tools || [];
        state.toolsLoaded = true;
        state.errors = result.errors || [];
        render();
      } catch (error) {
        alert(error.message);
      } finally {
        el('refreshTools').disabled = false;
        el('refreshTools').textContent = 'Refresh Tools';
      }
    }

    async function refreshStatus() {
      el('refreshStatus').disabled = true;
      el('refreshStatus').textContent = 'Checking...';
      try {
        state.status = await api('/api/status');
        render();
      } catch (error) {
        alert(error.message);
      } finally {
        el('refreshStatus').disabled = false;
        el('refreshStatus').textContent = 'Refresh Status';
      }
    }

    function hydrateDrafts() {
      for (const [id, agent] of Object.entries(state.config.agents)) {
        const key = keyFor('agent', id);
        if (!state.drafts[key]) state.drafts[key] = clone(agent);
      }
      for (const [id, profile] of Object.entries(state.config.profiles)) {
        const key = keyFor('profile', id);
        if (!state.drafts[key]) state.drafts[key] = clone(profile);
      }
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function currentDraft() {
      if (state.activeKind === 'providers') return null;
      if (!state.activeId) return null;
      return state.drafts[keyFor(state.activeKind, state.activeId)];
    }

    function setActive(kind, id) {
      state.activeKind = kind;
      state.activeId = id || '';
      hydrateDrafts();
      render();
    }

    function render() {
      hydrateDrafts();
      renderProviderNav();
      renderEntities();
      renderProviderFilter();
      renderStatusGrid();
      renderStaleNotice();
      renderDetails();
      renderTools();
    }

    function renderStatusGrid() {
      const summary = state.status?.summary || { ok: 0, down: 0, disabled: 0, tools: state.tools.length };
      el('statusGrid').innerHTML =
        statusTile(summary.ok, 'Providers OK', 'runtime-ok') +
        statusTile(summary.down, 'Providers Down', summary.down > 0 ? 'runtime-down' : '') +
        statusTile(summary.disabled, 'Disabled', 'runtime-disabled') +
        statusTile(summary.tools || state.tools.length, 'Tools Visible', '');
    }

    function statusTile(value, label, className) {
      return '<div class="status-tile">' +
        '<div class="status-value ' + escapeHtml(className) + '">' + escapeHtml(value) + '</div>' +
        '<div class="status-label">' + escapeHtml(label) + '</div>' +
      '</div>';
    }

    function renderStaleNotice() {
      const stale = staleProviders();
      el('staleNotice').hidden = stale.length === 0;
      el('staleNotice').textContent = stale.length
        ? 'Tool list stale: ' + stale.join(', ')
        : '';
    }

    function renderProviderNav() {
      el('manageProviders').classList.toggle('active', state.activeKind === 'providers');
    }

    function renderProvidersManager() {
      el('tools').innerHTML =
        '<div class="provider-list">' +
        Object.entries(state.config.providers).map(([id, provider]) => providerRow(id, provider)).join('') +
        '</div>';
      document.querySelectorAll('[data-provider-toggle]').forEach((button) => {
        button.addEventListener('click', () => toggleProvider(button.dataset.provider).catch((error) => alert(error.message)));
      });
      document.querySelectorAll('[data-provider-edit]').forEach((button) => {
        button.addEventListener('click', () => editProvider(button.dataset.provider).catch((error) => alert(error.message)));
      });
      document.querySelectorAll('[data-provider-delete]').forEach((button) => {
        button.addEventListener('click', () => deleteProvider(button.dataset.provider).catch((error) => alert(error.message)));
      });
    }

    function providerRow(id, provider) {
      const runtime = providerStatus(id);
      const stale = isProviderToolListStale(id);
      const disabled = provider.enabled ? '' : ' disabled';
      const toggleLabel = provider.enabled ? 'Disable' : 'Enable';
      const statusClass = provider.enabled ? 'provider-status-enabled' : 'provider-status-disabled';
      const runtimeClass = stale
        ? 'runtime-stale'
        : runtime
          ? 'runtime-' + runtime.status
          : 'runtime-disabled';
      const runtimeText = stale ? 'stale' : runtime ? runtime.status : provider.enabled ? 'unknown' : 'disabled';
      const tools = runtime ? String(runtime.toolCount) : '0';
      const server = runtime?.serverInfo ? runtime.serverInfo.name + ' ' + runtime.serverInfo.version : '';
      const title = stale ? 'Live tool names differ from the loaded tool table' : runtime?.error || server || runtimeText;
      return '<div class="provider-item' + disabled + '">' +
        '<div class="provider-name">' + escapeHtml(id) + '<span>' + escapeHtml(provider.type) + '</span></div>' +
        '<span class="pill ' + statusClass + '">' + (provider.enabled ? 'enabled' : 'disabled') + '</span>' +
        '<span class="pill ' + runtimeClass + '" title="' + escapeHtml(title) + '">' + escapeHtml(runtimeText) + '</span>' +
        '<span class="pill">' + escapeHtml(tools) + ' tools</span>' +
        '<button data-provider-toggle data-provider="' + escapeHtml(id) + '">' + toggleLabel + '</button>' +
        '<button data-provider-edit data-provider="' + escapeHtml(id) + '">Edit</button>' +
        '<button data-provider-delete data-provider="' + escapeHtml(id) + '">Del</button>' +
      '</div>';
    }

    function providerStatus(id) {
      return (state.status?.providers || []).find((provider) => provider.id === id);
    }

    function staleProviders() {
      if (!state.toolsLoaded || !state.status) return [];
      return state.status.providers
        .filter((provider) => isProviderToolListStale(provider.id))
        .map((provider) => provider.id);
    }

    function isProviderToolListStale(providerId) {
      const status = providerStatus(providerId);
      if (!state.toolsLoaded || !status || status.status !== 'ok') return false;
      return status.toolFingerprint !== loadedToolFingerprint(providerId);
    }

    function loadedToolFingerprint(providerId) {
      return state.tools
        .filter((tool) => tool.provider === providerId)
        .map((tool) => tool.name)
        .sort()
        .join('\\n');
    }

    function renderEntities() {
      el('agents').innerHTML = Object.keys(state.config.agents).map((id) => entityButton('agent', id)).join('');
      el('profiles').innerHTML = Object.keys(state.config.profiles).map((id) => entityButton('profile', id)).join('');
      document.querySelectorAll('[data-entity]').forEach((button) => {
        button.addEventListener('click', () => setActive(button.dataset.kind, button.dataset.id));
      });
    }

    function entityButton(kind, id) {
      const active = state.activeKind === kind && state.activeId === id ? ' active' : '';
      return '<button class="entity' + active + '" data-entity data-kind="' + kind + '" data-id="' + escapeHtml(id) + '">' + escapeHtml(id) + '</button>';
    }

    function renderProviderFilter() {
      const providers = Array.from(new Set(state.tools.map((tool) => tool.provider))).sort();
      el('providerFilter').innerHTML = '<option value="all">All providers</option>' + providers.map((provider) => '<option value="' + escapeHtml(provider) + '">' + escapeHtml(provider) + '</option>').join('');
      el('providerFilter').value = state.provider;
    }

    function renderDetails() {
      const draft = currentDraft();
      el('activeTitle').textContent = state.activeKind === 'providers' ? 'Providers' : state.activeId || 'Select an agent or profile';
      el('activeMeta').textContent =
        state.activeKind === 'providers'
          ? 'Top-level tool sources'
          : state.activeKind === 'agent'
            ? 'Agent allow/ask/deny policy'
            : 'Reusable profile allow/ask/deny policy';
      el('deleteEntity').style.display = state.activeKind === 'providers' ? 'none' : 'inline-flex';
      el('addProvider').style.display = state.activeKind === 'providers' ? 'inline-flex' : 'none';
      el('deleteEntity').disabled = !state.activeId;
      el('profilePanel').style.display = state.activeKind === 'agent' ? 'block' : 'none';

      if (!draft) {
        if (state.activeKind === 'providers') {
          const providers = Object.values(state.config.providers);
          const enabled = providers.filter((provider) => provider.enabled).length;
          const status = state.status?.summary || { ok: 0, down: 0, disabled: providers.length - enabled, tools: state.tools.length };
          const stale = staleProviders().length;
          el('summary').innerHTML =
            '<span class="pill">enabled ' + enabled + '</span>' +
            '<span class="pill runtime-ok">ok ' + status.ok + '</span>' +
            '<span class="pill runtime-down">down ' + status.down + '</span>' +
            '<span class="pill runtime-stale">stale ' + stale + '</span>' +
            '<span class="pill">tools ' + status.tools + '</span>';
        } else {
          el('summary').innerHTML = '<div class="empty">Nothing selected.</div>';
        }
        renderDiagnostics();
        return;
      }

      const denyCount = draft.deny.length;
      el('summary').innerHTML =
        '<span class="pill">allow ' + draft.allow.length + '</span>' +
        '<span class="pill">ask ' + draft.ask.length + '</span>' +
        '<span class="pill">deny ' + denyCount + '</span>';

      const profiles = Object.keys(state.config.profiles);
      el('profileChecks').innerHTML = profiles.length
        ? profiles.map((id) => {
            const checked = (draft.extends || []).includes(id) ? ' checked' : '';
            return '<label class="check"><input type="checkbox" data-profile="' + escapeHtml(id) + '"' + checked + '> ' + escapeHtml(id) + '</label>';
          }).join('')
        : '<div class="subtle">No profiles yet.</div>';
      document.querySelectorAll('[data-profile]').forEach((box) => {
        box.addEventListener('change', () => {
          const next = new Set(draft.extends || []);
          if (box.checked) next.add(box.dataset.profile);
          else next.delete(box.dataset.profile);
          draft.extends = Array.from(next);
          renderDetails();
        });
      });

      renderDiagnostics();
    }

    function renderDiagnostics() {
      const diagnostics = [...(state.config.diagnostics || [])];
      for (const error of state.errors) diagnostics.push({ level: 'warn', message: error });
      el('diagnostics').innerHTML = diagnostics.length
        ? diagnostics.map((d) => '<div class="diagnostic ' + escapeHtml(d.level) + '">' + escapeHtml((d.agent ? '[' + d.agent + '] ' : '') + d.message) + '</div>').join('')
        : '<div class="subtle">No diagnostics.</div>';
    }

    function renderTools() {
      el('search').disabled = state.activeKind === 'providers';
      el('providerFilter').disabled = state.activeKind === 'providers';
      el('decisionFilter').disabled = state.activeKind === 'providers';
      el('bulkAllow').style.display = state.activeKind === 'providers' ? 'none' : 'inline-flex';
      el('bulkAsk').style.display = state.activeKind === 'providers' ? 'none' : 'inline-flex';
      el('bulkDeny').style.display = state.activeKind === 'providers' ? 'none' : 'inline-flex';
      el('bulkClear').style.display = state.activeKind === 'providers' ? 'none' : 'inline-flex';
      el('resetRules').style.display = state.activeKind === 'providers' ? 'none' : 'inline-flex';
      el('recommendedRules').style.display = state.activeKind === 'providers' ? 'none' : 'inline-flex';
      el('resetAllRules').style.display = state.activeKind === 'providers' ? 'none' : 'inline-flex';
      if (state.activeKind === 'providers') {
        renderProvidersManager();
        return;
      }
      const draft = currentDraft();
      if (!draft) {
        el('tools').innerHTML = '<div class="empty">Create or select an agent/profile to begin.</div>';
        return;
      }
      if (state.tools.length === 0) {
        el('tools').innerHTML = '<div class="empty">Refresh endpoints to load configured tools.</div>';
        return;
      }

      const visible = filteredTools();
      el('tools').innerHTML = visible.length
        ? visible.map((tool) => toolRow(tool, getDecision(draft, tool.name))).join('')
        : '<div class="empty">No tools match the current filters.</div>';

      document.querySelectorAll('[data-rule]').forEach((button) => {
        button.addEventListener('click', () => {
          setDecision(draft, button.dataset.tool, button.dataset.decision);
          render();
        });
      });
      document.querySelectorAll('[data-description-toggle]').forEach((button) => {
        button.addEventListener('click', () => {
          state.descriptionExpanded[button.dataset.tool] = !state.descriptionExpanded[button.dataset.tool];
          renderTools();
        });
      });
    }

    function filteredTools() {
      const draft = currentDraft();
      const query = state.search.trim().toLowerCase();
      return state.tools.filter((tool) => {
        const text = (tool.name + ' ' + (tool.description || '') + ' ' + (tool.tags || []).join(' ')).toLowerCase();
        if (query && !text.includes(query)) return false;
        if (state.provider !== 'all' && tool.provider !== state.provider) return false;
        if (state.decision !== 'all' && getDecision(draft, tool.name) !== state.decision) return false;
        return true;
      });
    }

    function toolRow(tool, decision) {
      const tags = tool.tags && tool.tags.length ? tool.tags : ['untagged'];
      const tagHtml = tags.map((tag) => '<span class="tag ' + tagClass(tag) + '">' + escapeHtml(tag) + '</span>').join('');
      const recommended = '<span class="tag tag-recommended ' + recommendedClass(tool.recommended) + '">recommended ' + escapeHtml(tool.recommended) + '</span>';
      const description = tool.description || 'No description';
      const expandable = descriptionIsExpandable(description);
      const expanded = Boolean(state.descriptionExpanded[tool.name]);
      const descriptionClass = expandable && !expanded ? ' collapsed' : '';
      const toggle = expandable
        ? '<button class="description-toggle" data-description-toggle data-tool="' + escapeHtml(tool.name) + '">' + (expanded ? 'Show less' : 'Show more') + '</button>'
        : '';
      return '<div class="tool-row">' +
        '<div class="tool-name"><span class="provider">' + escapeHtml(tool.provider) + '</span><br>' + escapeHtml(tool.shortName || tool.name) + '</div>' +
        '<div class="description"><div class="description-content' + descriptionClass + '">' + formatDescription(description) + '</div>' + toggle + '<div class="tag-list">' + tagHtml + recommended + '</div></div>' +
        '<div class="rule-actions">' +
          ruleButton(tool.name, 'allow', decision) +
          ruleButton(tool.name, 'ask', decision) +
          ruleButton(tool.name, 'deny', decision) +
          ruleButton(tool.name, 'unset', decision) +
        '</div>' +
      '</div>';
    }

    function descriptionIsExpandable(description) {
      return description.length > 260 || description.split(/\\r?\\n/).length > 3;
    }

    function formatDescription(description) {
      const text = String(description || '').trim();
      if (!text) return '<p>No description</p>';
      const normalized = normalizeDescription(text);
      return normalized.split(/\\n+/).map((line) => line.trim()).filter(Boolean).map(formatDescriptionLine).join('');
    }

    function normalizeDescription(text) {
      return text
        .replace(/\\r\\n/g, '\\n')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n[ \\t]+/g, '\\n')
        .replace(/\\s+(#{1,4}\\s+)/g, '\\n$1')
        .replace(/(#{1,4}\\s+[A-Za-z][^#\\n]{0,80}?)\\s+(\\d+\\.\\s+)/g, '$1\\n$2')
        .replace(/([.!?])\\s+(\\d+\\.\\s+)/g, '$1\\n$2');
    }

    function formatDescriptionLine(line) {
      const heading = line.match(/^#{1,4}\\s+(.+)$/);
      if (heading) return '<h4>' + formatInline(heading[1]) + '</h4>';
      const step = line.match(/^\\d+\\.\\s+(.+)$/);
      if (step) return '<p class="description-step">' + formatInline(line) + '</p>';
      const bullet = line.match(/^[-*]\\s+(.+)$/);
      if (bullet) return '<p class="description-step">' + formatInline(line) + '</p>';
      return '<p>' + formatInline(line) + '</p>';
    }

    function formatInline(value) {
      return escapeHtml(value)
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');
    }

    function tagClass(tag) {
      if (tag === 'destructive' || tag === 'injection') return 'tag-danger';
      if (tag === 'open-world') return 'tag-warn';
      if (tag === 'readonly' || tag === 'idempotent') return 'tag-good';
      return '';
    }

    function recommendedClass(decision) {
      if (decision === 'deny') return 'tag-danger';
      if (decision === 'ask') return 'tag-warn';
      return 'tag-good';
    }

    function ruleButton(tool, decision, activeDecision) {
      const active = decision === activeDecision ? ' active' : '';
      const label = decision === 'unset' ? 'Clear' : decision;
      return '<button class="' + active + '" data-rule data-tool="' + escapeHtml(tool) + '" data-decision="' + decision + '">' + label + '</button>';
    }

    function getDecision(draft, tool) {
      if (draft.deny.includes(tool)) return 'deny';
      if (draft.ask.includes(tool)) return 'ask';
      if (draft.allow.includes(tool)) return 'allow';
      return 'unset';
    }

    function setDecision(draft, tool, decision) {
      draft.allow = draft.allow.filter((item) => item !== tool);
      draft.ask = draft.ask.filter((item) => item !== tool);
      draft.deny = draft.deny.filter((item) => item !== tool);
      if (decision === 'allow') draft.allow.push(tool);
      if (decision === 'ask') draft.ask.push(tool);
      if (decision === 'deny') draft.deny.push(tool);
    }

    function setVisible(decision) {
      const draft = currentDraft();
      if (!draft) return;
      for (const tool of filteredTools()) {
        setDecision(draft, tool.name, decision);
      }
      render();
    }

    function resetVisibleToCurrentConfig() {
      const draft = currentDraft();
      if (!draft) return;
      if (state.activeKind === 'providers' || !state.activeId) return;
      const section = state.activeKind === 'agent' ? state.config.agents : state.config.profiles;
      const source = section[state.activeId];
      if (!source) return;
      for (const tool of filteredTools()) {
        setDecision(draft, tool.name, getDecision(source, tool.name));
      }
      render();
    }

    function resetAllToCurrentConfig() {
      if (state.activeKind === 'providers' || !state.activeId) return;
      const section = state.activeKind === 'agent' ? state.config.agents : state.config.profiles;
      const source = section[state.activeId];
      if (!source) return;
      state.drafts[keyFor(state.activeKind, state.activeId)] = clone(source);
      render();
    }

    function setRecommended() {
      const draft = currentDraft();
      if (!draft) return;
      for (const tool of filteredTools()) {
        setDecision(draft, tool.name, tool.recommended);
      }
      render();
    }

    async function saveCurrent() {
      const draft = currentDraft();
      if (!draft) return;
      const body = {
        kind: state.activeKind,
        id: state.activeId,
        extends: draft.extends || [],
        allow: draft.allow,
        ask: draft.ask,
        deny: draft.deny
      };
      state.config = await api('/api/rules', { method: 'POST', body: JSON.stringify(body) });
      state.drafts = {};
      hydrateDrafts();
      render();
    }

    async function addEntity(kind) {
      const id = prompt('New ' + kind + ' id');
      if (!id) return;
      state.config = await api('/api/entities', { method: 'POST', body: JSON.stringify({ kind, id }) });
      state.drafts = {};
      setActive(kind, id.trim());
    }

    async function addProvider() {
      const id = prompt('New provider id');
      if (!id) return;
      const type = prompt('Provider type: builtin, stdio, sse, or http', 'stdio');
      if (!type) return;
      const body = { id: id.trim(), type: type.trim(), enabled: true };
      await fillProviderFields(body);
      state.config = await api('/api/providers', { method: 'POST', body: JSON.stringify(body) });
      await Promise.all([refreshStatus(), refreshTools()]);
      render();
    }

    async function editProvider(id) {
      const provider = state.config.providers[id];
      if (!provider) return;
      const body = { id, type: provider.type, enabled: provider.enabled };
      await fillProviderFields(body, provider);
      state.config = await api('/api/providers', { method: 'POST', body: JSON.stringify(body) });
      await Promise.all([refreshStatus(), refreshTools()]);
      render();
    }

    async function toggleProvider(id) {
      const provider = state.config.providers[id];
      if (!provider) return;
      const body = { ...provider, id, enabled: !provider.enabled };
      state.config = await api('/api/providers', { method: 'POST', body: JSON.stringify(body) });
      await Promise.all([refreshStatus(), refreshTools()]);
      render();
    }

    async function deleteProvider(id) {
      if (!confirm('Delete provider "' + id + '"?')) return;
      state.config = await api('/api/providers/' + encodeURIComponent(id), { method: 'DELETE' });
      await Promise.all([refreshStatus(), refreshTools()]);
      render();
    }

    async function fillProviderFields(body, provider) {
      if (body.type === 'builtin') return;
      if (body.type === 'stdio') {
        const command = prompt('Command', provider?.command || '');
        if (command === null) throw new Error('Cancelled');
        const args = prompt('Args, one per line', (provider?.args || []).join('\\n'));
        if (args === null) throw new Error('Cancelled');
        body.command = command;
        body.args = args.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean);
        return;
      }
      if (body.type === 'sse' || body.type === 'http') {
        const url = prompt('URL', provider?.url || '');
        if (url === null) throw new Error('Cancelled');
        body.url = url;
        if (body.type === 'http') {
          body.oauth = confirm('Enable OAuth for this HTTP provider?');
        }
        return;
      }
      throw new Error('Provider type must be builtin, stdio, sse, or http');
    }

    async function deleteCurrent() {
      if (!state.activeId) return;
      if (!confirm('Delete ' + state.activeKind + ' "' + state.activeId + '"?')) return;
      state.config = await api('/api/entities/' + state.activeKind + '/' + encodeURIComponent(state.activeId), { method: 'DELETE' });
      state.drafts = {};
      state.activeId = '';
      await loadState();
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char]));
    }

    el('refreshTools').addEventListener('click', refreshTools);
    el('refreshStatus').addEventListener('click', refreshStatus);
    el('saveRules').addEventListener('click', () => saveCurrent().catch((error) => alert(error.message)));
    el('manageProviders').addEventListener('click', () => setActive('providers'));
    el('addProvider').addEventListener('click', () => addProvider().catch((error) => alert(error.message)));
    el('addAgent').addEventListener('click', () => addEntity('agent').catch((error) => alert(error.message)));
    el('addProfile').addEventListener('click', () => addEntity('profile').catch((error) => alert(error.message)));
    el('deleteEntity').addEventListener('click', () => deleteCurrent().catch((error) => alert(error.message)));
    el('search').addEventListener('input', (event) => { state.search = event.target.value; renderTools(); });
    el('providerFilter').addEventListener('change', (event) => { state.provider = event.target.value; renderTools(); });
    el('decisionFilter').addEventListener('change', (event) => { state.decision = event.target.value; renderTools(); });
    el('bulkAllow').addEventListener('click', () => setVisible('allow'));
    el('bulkAsk').addEventListener('click', () => setVisible('ask'));
    el('bulkDeny').addEventListener('click', () => setVisible('deny'));
    el('bulkClear').addEventListener('click', () => setVisible('unset'));
    el('resetRules').addEventListener('click', resetVisibleToCurrentConfig);
    el('resetAllRules').addEventListener('click', resetAllToCurrentConfig);
    el('recommendedRules').addEventListener('click', setRecommended);

    loadState().then(() => Promise.all([refreshStatus(), refreshTools()])).catch((error) => {
      document.body.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>';
    });
  </script>
</body>
</html>`;
