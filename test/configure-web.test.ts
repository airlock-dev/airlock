import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  annotationTags,
  createConfigureWebApp,
  createEntity,
  deleteProvider,
  readState,
  recommendedDecision,
  saveRules,
  upsertProvider,
} from '../src/configure-web/cli.js';

describe('configure-web config helpers', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-web-'));
    configPath = join(dir, 'airlock.yaml');
    writeFileSync(
      configPath,
      `
providers:
  exec: builtin
  old:
    type: stdio
    enabled: false
    command: echo
profiles:
  readonly:
    allow:
      - exec/run
    deny:
      - exec/danger
agents:
  dev:
    extends:
      - readonly
    allow: []
    ask: []
    deny: []
approvals:
  provider:
    type: stdio
`
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads editable agents and profiles without applying inheritance', () => {
    const state = readState(configPath);

    expect(state.providers.exec).toEqual({ type: 'builtin', enabled: true });
    expect(state.providers.old).toMatchObject({ type: 'stdio', enabled: false, command: 'echo' });
    expect(state.agents.dev.extends).toEqual(['readonly']);
    expect(state.profiles.readonly.allow).toEqual(['exec/run']);
    expect(state.profiles.readonly.deny).toEqual(['exec/danger']);
  });

  it('saves only editable agent rule fields and keeps backups', () => {
    saveRules(configPath, {
      kind: 'agent',
      id: 'dev',
      extends: [],
      allow: ['exec/run'],
      ask: [],
      deny: ['exec/danger'],
    });

    const parsed = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, Record<string, unknown>>;

    expect(agents.dev.allow).toEqual(['exec/run']);
    expect(agents.dev.deny).toEqual(['exec/danger']);
    expect(readFileSync(join(dir, 'airlock.bak'), 'utf8')).toContain('readonly');
  });

  it('creates empty profiles', () => {
    const state = createEntity(configPath, { kind: 'profile', id: 'writer' });

    expect(state.profiles.writer).toEqual({ allow: [], ask: [], deny: [] });
  });

  it('saves profile deny rules', () => {
    const state = saveRules(configPath, {
      kind: 'profile',
      id: 'readonly',
      allow: ['exec/run'],
      ask: [],
      deny: ['exec/danger'],
    });

    expect(state.profiles.readonly.deny).toEqual(['exec/danger']);
  });

  it('adds and disables providers without dropping connection fields', () => {
    const added = upsertProvider(configPath, {
      id: 'echo',
      type: 'stdio',
      enabled: true,
      command: 'node',
      args: ['server.js'],
    });
    expect(added.providers.echo).toMatchObject({
      type: 'stdio',
      enabled: true,
      command: 'node',
      args: ['server.js'],
    });

    const disabled = upsertProvider(configPath, {
      id: 'echo',
      type: 'stdio',
      enabled: false,
    });
    expect(disabled.providers.echo).toMatchObject({
      type: 'stdio',
      enabled: false,
      command: 'node',
      args: ['server.js'],
    });
  });

  it('deletes providers', () => {
    const state = deleteProvider(configPath, 'old');

    expect(state.providers.old).toBeUndefined();
  });

  it('matches configure-agent recommendation rules', () => {
    expect(recommendedDecision({ destructiveHint: true })).toBe('ask');
    expect(recommendedDecision({ openWorldHint: true })).toBe('ask');
    expect(recommendedDecision({ readOnlyHint: true })).toBe('allow');
    expect(recommendedDecision({}, ['override\\s+(all\\s+)?instructions?'])).toBe('deny');
    expect(
      annotationTags({ readOnlyHint: true, openWorldHint: true }, [
        'override\\s+(all\\s+)?instructions?',
      ])
    ).toEqual(['readonly', 'open-world', 'injection']);
  });
});

describe('configure-web API', () => {
  it('serves state and builtin tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-web-api-'));
    const configPath = join(dir, 'airlock.yaml');
    writeFileSync(
      configPath,
      `
providers:
  exec: builtin
  disabled-bad:
    type: stdio
    enabled: false
    command: definitely-not-a-command
agents:
  dev:
    allow: []
approvals:
  provider:
    type: stdio
`
    );

    const app = createConfigureWebApp(configPath);
    await app.ready();

    const stateRes = await app.inject('/api/state');
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json().agents.dev).toBeTruthy();
    expect(stateRes.json().providers.exec).toEqual({ type: 'builtin', enabled: true });

    const toolsRes = await app.inject('/api/tools');
    expect(toolsRes.statusCode).toBe(200);
    expect(toolsRes.json().tools.map((tool: { name: string }) => tool.name)).toContain('exec/run');
    expect(toolsRes.json().errors).not.toContain(expect.stringContaining('disabled-bad'));
    expect(
      toolsRes.json().tools.find((tool: { name: string }) => tool.name === 'exec/run')
    ).toMatchObject({
      tags: [],
      recommended: 'allow',
      suspiciousPatterns: [],
    });

    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
