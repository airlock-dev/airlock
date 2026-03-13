import { describe, it, expect } from 'vitest';
import { buildCommand } from '../src/backend/cli/builder.js';
import type { CliCommandConfig } from '../src/config/schema.js';

function makeCmd(overrides: Partial<CliCommandConfig> = {}): CliCommandConfig {
  return {
    exec: 'echo hello',
    params: {},
    timeout: 30,
    ...overrides,
  };
}

describe('buildCommand()', () => {
  it('returns exec string when no params', () => {
    const result = buildCommand(makeCmd({ exec: 'git status' }), {});
    expect(result).toBe('git status');
  });

  it('interpolates template params with escaping', () => {
    const cmd = makeCmd({
      exec: 'git push {remote} {branch}',
      params: {
        remote: { type: 'string', positional: false, required: true },
        branch: { type: 'string', positional: false, required: true },
      },
    });
    const result = buildCommand(cmd, { remote: 'origin', branch: 'main' });
    expect(result).toBe("git push 'origin' 'main'");
  });

  it('handles boolean flags', () => {
    const cmd = makeCmd({
      exec: 'git log',
      params: {
        oneline: { type: 'boolean', flag: '--oneline', positional: false, required: false },
      },
    });
    expect(buildCommand(cmd, { oneline: true })).toBe('git log --oneline');
    expect(buildCommand(cmd, { oneline: false })).toBe('git log');
    expect(buildCommand(cmd, {})).toBe('git log');
  });

  it('handles flag with value', () => {
    const cmd = makeCmd({
      exec: 'git log',
      params: {
        author: { type: 'string', flag: '--author', positional: false, required: false },
      },
    });
    expect(buildCommand(cmd, { author: 'Alice' })).toBe("git log --author 'Alice'");
  });

  it('handles positional params', () => {
    const cmd = makeCmd({
      exec: 'cat',
      params: {
        file: { type: 'string', positional: true, required: true },
      },
    });
    expect(buildCommand(cmd, { file: '/etc/hostname' })).toBe("cat '/etc/hostname'");
  });

  it('removes unreplaced optional template placeholders', () => {
    const cmd = makeCmd({
      exec: 'git push {remote} {branch}',
      params: {
        remote: { type: 'string', positional: false, required: false },
        branch: { type: 'string', positional: false, required: false },
      },
    });
    expect(buildCommand(cmd, { remote: 'origin' })).toBe("git push 'origin'");
  });

  it('throws on missing required param', () => {
    const cmd = makeCmd({
      exec: 'git push {remote}',
      params: {
        remote: { type: 'string', positional: false, required: true },
      },
    });
    expect(() => buildCommand(cmd, {})).toThrow(/Required parameter "remote"/);
  });

  it('escapes injection attempts in template params', () => {
    const cmd = makeCmd({
      exec: 'echo {msg}',
      params: {
        msg: { type: 'string', positional: false, required: true },
      },
    });
    const result = buildCommand(cmd, { msg: '$(rm -rf /)' });
    expect(result).toBe("echo '$(rm -rf /)'");
  });

  it('escapes injection attempts in flag values', () => {
    const cmd = makeCmd({
      exec: 'git log',
      params: {
        author: { type: 'string', flag: '--author', positional: false, required: false },
      },
    });
    const result = buildCommand(cmd, { author: "'; rm -rf /; echo '" });
    expect(result).toContain("'\\''");
  });

  it('handles number type params', () => {
    const cmd = makeCmd({
      exec: 'git log',
      params: {
        count: { type: 'number', flag: '-n', positional: false, required: false },
      },
    });
    expect(buildCommand(cmd, { count: 5 })).toBe("git log -n '5'");
  });
});
