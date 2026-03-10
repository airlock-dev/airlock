import { describe, it, expect } from 'vitest';
import { matches, matchesCommand } from '../src/allowlist/pattern.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import type { AgentConfig } from '../src/config/schema.js';

describe('matches()', () => {
  it('exact match', () => {
    expect(matches('github/create_pr', 'github/create_pr')).toBe(true);
    expect(matches('github/create_pr', 'github/list_prs')).toBe(false);
  });

  it('wildcard /* suffix', () => {
    expect(matches('github/*', 'github/create_pr')).toBe(true);
    expect(matches('github/*', 'github/list_prs')).toBe(true);
    expect(matches('github/*', 'github2/foo')).toBe(false);
    expect(matches('filesystem/*', 'filesystem/read_file')).toBe(true);
    expect(matches('filesystem/*', 'filesystem2/read')).toBe(false);
  });

  it('does not match nested paths', () => {
    expect(matches('github/*', 'github/foo/bar')).toBe(false);
  });
});

describe('matchesCommand()', () => {
  it('exact match', () => {
    expect(matchesCommand('git status', 'git status')).toBe(true);
    expect(matchesCommand('git status', 'git push')).toBe(false);
  });

  it('prefix wildcard', () => {
    expect(matchesCommand('git*', 'git status')).toBe(true);
    expect(matchesCommand('git*', 'git push origin main')).toBe(true);
    expect(matchesCommand('git*', 'npm install')).toBe(false);
  });
});

function makeAgent(allow: string[], hitl: string[] = []): AgentConfig {
  return {
    allow,
    hitl,
    tool_overrides: {},
    exec: { allow: [], hitl: [], deny: [], env: {}, default_timeout_ms: 30000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 30000 },
  };
}

describe('AllowlistEngine', () => {
  it('denies tools not in allow list', () => {
    const engine = new AllowlistEngine({ agent1: makeAgent(['github/*']) });
    expect(engine.evaluate('agent1', 'slack/send_message')).toBe('deny');
  });

  it('allows tools in allow list', () => {
    const engine = new AllowlistEngine({ agent1: makeAgent(['github/*']) });
    expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
  });

  it('returns hitl for tools in hitl sublist', () => {
    const engine = new AllowlistEngine({ agent1: makeAgent(['github/*'], ['github/create_pr']) });
    expect(engine.evaluate('agent1', 'github/create_pr')).toBe('hitl');
    expect(engine.evaluate('agent1', 'github/list_prs')).toBe('allow');
  });

  it('denies unknown agent', () => {
    const engine = new AllowlistEngine({});
    expect(engine.evaluate('nobody', 'anything')).toBe('deny');
  });

  it('filterTools removes denied tools', () => {
    const engine = new AllowlistEngine({
      agent1: makeAgent(['github/*', 'filesystem/*']),
    });
    const tools = [
      { name: 'github/create_pr',    description: '', inputSchema: { type: 'object' as const, properties: {} } },
      { name: 'slack/send_message',  description: '', inputSchema: { type: 'object' as const, properties: {} } },
      { name: 'filesystem/read_file',description: '', inputSchema: { type: 'object' as const, properties: {} } },
    ];
    const filtered = engine.filterTools('agent1', tools);
    expect(filtered.map(t => t.name)).toEqual(['github/create_pr', 'filesystem/read_file']);
  });

  it('evaluateDomain: empty allowlist allows all', () => {
    const engine = new AllowlistEngine({ agent1: makeAgent([]) });
    expect(engine.evaluateDomain('agent1', 'example.com')).toBe(true);
  });

  it('evaluateDomain: blocks unlisted domains', () => {
    const agent = makeAgent([]);
    agent.http.domain_allowlist = ['api.example.com', '*.sentry.io'];
    const engine = new AllowlistEngine({ agent1: agent });
    expect(engine.evaluateDomain('agent1', 'api.example.com')).toBe(true);
    expect(engine.evaluateDomain('agent1', 'org.sentry.io')).toBe(true);
    expect(engine.evaluateDomain('agent1', 'evil.com')).toBe(false);
  });
});
