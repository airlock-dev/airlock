import { describe, it, expect } from 'vitest';
import { executeExec } from '../src/tools/exec.js';
import type { AgentConfig } from '../src/config/schema.js';

function makeAgentConfig(execOverrides: Partial<AgentConfig['exec']> = {}): AgentConfig {
  return {
    allow: ['exec/run'],
    ask: [],
    deny: [],
    tool_overrides: {},
    exec: {
      allow: ['*'],
      ask: [],
      deny: [],
      env: {},
      default_timeout_ms: 5000,
      ...execOverrides,
    },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 5000 },
  };
}

describe('executeExec()', () => {
  it('captures stdout', async () => {
    const result = await executeExec('echo hello', makeAgentConfig());
    expect(result.stdout.trim()).toBe('hello');
  });

  it('captures stderr', async () => {
    const result = await executeExec('echo error >&2', makeAgentConfig());
    expect(result.stderr.trim()).toBe('error');
  });

  it('returns correct exit code for success', async () => {
    const result = await executeExec('exit 0', makeAgentConfig());
    expect(result.exit_code).toBe(0);
  });

  it('returns correct exit code for failure', async () => {
    const result = await executeExec('exit 42', makeAgentConfig());
    expect(result.exit_code).toBe(42);
  });

  it('returns duration_ms', async () => {
    const result = await executeExec('echo hi', makeAgentConfig());
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.duration_ms).toBe('number');
  });

  it('respects cwd argument', async () => {
    const result = await executeExec('pwd', makeAgentConfig(), '/tmp');
    // macOS resolves /tmp → /private/tmp
    expect(result.stdout.trim()).toMatch(/^(\/tmp|\/private\/tmp)$/);
  });

  it('uses clean env from config (not inheriting all process env)', async () => {
    const result = await executeExec(
      'echo ${MY_SECRET_VAR:-NOTSET}',
      makeAgentConfig({ env: {} }),
    );
    expect(result.stdout.trim()).toBe('NOTSET');
  });

  it('injects only configured env vars', async () => {
    const result = await executeExec(
      'echo $CUSTOM_VAR',
      makeAgentConfig({ env: { CUSTOM_VAR: 'injected' } }),
    );
    expect(result.stdout.trim()).toBe('injected');
  });

  it('times out and sets timed_out flag', async () => {
    // Use a shell builtin infinite loop — works with empty env (no PATH needed)
    const result = await executeExec('while :; do :; done', makeAgentConfig({ default_timeout_ms: 100 }));
    expect(result.timed_out).toBe(true);
  }, 5000);

  it('returns non-zero exit code after timeout', async () => {
    const result = await executeExec('while :; do :; done', makeAgentConfig({ default_timeout_ms: 100 }));
    expect(result.exit_code === null || result.exit_code !== 0).toBe(true);
  }, 5000);

  it('per-call timeout_ms overrides config default', async () => {
    const result = await executeExec('while :; do :; done', makeAgentConfig({ default_timeout_ms: 30000 }), undefined, 100);
    expect(result.timed_out).toBe(true);
  }, 5000);

  it('handles commands that produce no output', async () => {
    const result = await executeExec('true', makeAgentConfig());
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exit_code).toBe(0);
  });

  it('handles multiline output', async () => {
    const result = await executeExec('printf "line1\nline2\nline3\n"', makeAgentConfig());
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(['line1', 'line2', 'line3']);
  });
});
