import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { stringifyPreservingComments } from '../src/config/yaml-merge.js';
import { rememberAllow } from '../src/config/mutator.js';
import { createConfigureWebApp } from '../src/configure-web/cli.js';

const RAW = `# Top of file
providers:
  exec: builtin # built-in shell
  github:
    type: stdio
    command: npx # pinned elsewhere
agents:
  # The coding agent
  dev:
    allow:
      - exec/run
    ask: []
approvals:
  provider:
    type: stdio
`;

describe('stringifyPreservingComments', () => {
  it('keeps comments on untouched keys and applies changes', () => {
    const next = parseYaml(RAW) as Record<string, any>;
    next.agents.dev.ask = ['github/create_issue'];
    next.providers.linear = { type: 'http', url: 'https://example.com/mcp' };
    delete next.providers.github;

    const out = stringifyPreservingComments(RAW, next);

    expect(out).toContain('# Top of file');
    expect(out).toContain('# built-in shell');
    expect(out).toContain('# The coding agent');
    expect(out).not.toContain('pinned elsewhere');
    expect(parseYaml(out)).toEqual(next);
  });

  it('leaves the text unchanged when nothing changed', () => {
    expect(stringifyPreservingComments(RAW, parseYaml(RAW))).toBe(RAW);
  });
});

describe('config writers keep comments', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-yaml-merge-'));
    configPath = join(dir, 'airlock.yaml');
    writeFileSync(configPath, RAW);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('when "always allow" is remembered from an approval', () => {
    rememberAllow({ configPath, agentId: 'dev', tool: 'github/create_issue', mode: 'always' });

    const raw = readFileSync(configPath, 'utf8');
    expect(raw).toContain('# The coding agent');
    expect(raw).toContain('# built-in shell');
    expect((parseYaml(raw) as any).agents.dev.allow).toContain('github/create_issue');
  });

  it('when the dashboard saves a provider', async () => {
    const app = createConfigureWebApp(configPath);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: { id: 'linear', type: 'http', url: 'https://example.com/mcp' },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const raw = readFileSync(configPath, 'utf8');
    expect(raw).toContain('# Top of file');
    expect(raw).toContain('# The coding agent');
    expect((parseYaml(raw) as any).providers.linear.url).toBe('https://example.com/mcp');
  });
});
