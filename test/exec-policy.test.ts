import { describe, it, expect } from 'vitest';
import { evaluateExecCommand } from '../src/tools/exec.js';
import type { AgentConfig } from '../src/config/schema.js';

function makeAgent(
  allow: string[],
  hitl: string[],
  deny: string[],
): AgentConfig {
  return {
    allow: [],
    hitl: [],
    tool_overrides: {},
    exec: { allow, hitl, deny, env: {}, default_timeout_ms: 30000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 30000 },
  };
}

describe('evaluateExecCommand()', () => {
  it('deny takes priority over hitl and allow', () => {
    const agent = makeAgent(['*'], ['*'], ['sudo*']);
    expect(evaluateExecCommand('sudo rm -rf /', agent)).toBe('deny');
  });

  it('hitl triggers for matching commands', () => {
    const agent = makeAgent(['git*'], ['git push*'], []);
    expect(evaluateExecCommand('git push origin main', agent)).toBe('hitl');
    expect(evaluateExecCommand('git status', agent)).toBe('allow');
  });

  it('allow passes through', () => {
    const agent = makeAgent(['git status', 'npm test'], [], []);
    expect(evaluateExecCommand('git status', agent)).toBe('allow');
    expect(evaluateExecCommand('npm test', agent)).toBe('allow');
  });

  it('fail-closed: deny by default if no pattern matches', () => {
    const agent = makeAgent(['git status'], [], []);
    expect(evaluateExecCommand('curl https://example.com', agent)).toBe('deny');
  });

  it('hard deny sudo rm -rf', () => {
    const agent = makeAgent(['*'], [], ['sudo*']);
    expect(evaluateExecCommand('sudo rm -rf /', agent)).toBe('deny');
  });
});
