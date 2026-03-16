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

function makeAgent(allow: string[], ask: string[] = [], deny: string[] = []): AgentConfig {
  return {
    allow,
    ask,
    notify: [],
    deny,
    tool_overrides: {},
    exec: { allow: [], ask: [], notify: [], deny: [], env: {}, default_timeout_ms: 30000 },
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

  it('returns ask for tools in ask list', () => {
    const engine = new AllowlistEngine({ agent1: makeAgent(['github/*'], ['github/create_pr']) });
    expect(engine.evaluate('agent1', 'github/create_pr')).toBe('ask');
    expect(engine.evaluate('agent1', 'github/list_prs')).toBe('allow');
  });

  it('ask implies allow — no need to also put in allow list', () => {
    // Only in ask, NOT in allow — should still return ask (not deny)
    const engine = new AllowlistEngine({ agent1: makeAgent([], ['github/create_pr']) });
    expect(engine.evaluate('agent1', 'github/create_pr')).toBe('ask');
  });

  it('deny takes priority over allow and ask', () => {
    const engine = new AllowlistEngine({
      agent1: makeAgent(['github/*'], ['github/create_pr'], ['github/create_pr']),
    });
    expect(engine.evaluate('agent1', 'github/create_pr')).toBe('deny');
  });

  it('deny wildcard blocks everything in namespace', () => {
    const engine = new AllowlistEngine({
      agent1: makeAgent(['github/*'], [], ['github/*']),
    });
    expect(engine.evaluate('agent1', 'github/create_pr')).toBe('deny');
    expect(engine.evaluate('agent1', 'github/list_prs')).toBe('deny');
  });

  it('denies unknown agent', () => {
    const engine = new AllowlistEngine({});
    expect(engine.evaluate('nobody', 'anything')).toBe('deny');
  });

  it('reload() updates agent configs', () => {
    const engine = new AllowlistEngine({ agent1: makeAgent(['github/*']) });
    expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
    engine.reload({ agent1: makeAgent(['filesystem/*']) });
    expect(engine.evaluate('agent1', 'github/create_pr')).toBe('deny');
    expect(engine.evaluate('agent1', 'filesystem/read_file')).toBe('allow');
  });
});
