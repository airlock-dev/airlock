import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyProfiles } from '../src/config/profiles.js';
import { GatewayConfig } from '../src/config/schema.js';
import { checkConfig, lintCommand, whoCan } from '../src/introspect/cli.js';

function lintYaml(yaml: string, args: string[] = []): ReturnType<typeof lintCommand> {
  const dir = mkdtempSync(join(tmpdir(), 'airlock-lint-cli-'));
  try {
    const path = join(dir, 'airlock.yaml');
    writeFileSync(path, yaml);
    return lintCommand(['--config', path, ...args]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const INFO_ONLY_LINT_YAML = `
providers:
  github: builtin
profiles:
  github-write:
    allow:
      - "github/*"
agents:
  selene:
    allow:
      - "github/list_issues"
    deny:
      - "github/delete_repo"
      - "github/push_files"
      - "github/create_or_update_file"
      - "github/merge_pull_request"
`;

describe('introspection CLI helpers', () => {
  it('reverse maps effective decisions through the allowlist engine', () => {
    const config = GatewayConfig.parse({
      providers: {
        github: 'builtin',
      },
      profiles: {
        github_rw: {
          allow: ['github/*'],
          deny: ['github/delete_repo'],
        },
      },
      agents: {
        dev: {
          extends: ['github_rw'],
        },
        reviewer: {
          ask: ['github/create_pr'],
        },
      },
    });
    applyProfiles(config);

    expect(whoCan(config, 'github/create_pr')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'dev',
          decision: 'allow',
          match: expect.objectContaining({ pattern: 'github/*' }),
        }),
        expect.objectContaining({
          agent: 'reviewer',
          decision: 'ask',
          match: expect.objectContaining({ pattern: 'github/create_pr' }),
        }),
      ])
    );
    expect(whoCan(config, 'github/delete_repo', 'deny')).toEqual([
      expect.objectContaining({
        agent: 'dev',
        decision: 'deny',
        match: expect.objectContaining({ pattern: 'github/delete_repo' }),
      }),
      expect.objectContaining({
        agent: 'reviewer',
        decision: 'default-deny',
      }),
    ]);
  });

  it('checks config structure without resolving env vars when requested', () => {
    delete process.env['AIRLOCK_TEST_SECRET'];
    const dir = mkdtempSync(join(tmpdir(), 'airlock-introspect-cli-'));
    try {
      const path = join(dir, 'airlock.yaml');
      writeFileSync(
        path,
        `
server:
  auth_required: true
  api_secret: "\${AIRLOCK_TEST_SECRET}"
providers:
  github: builtin
agents:
  dev:
    token: "\${AIRLOCK_TEST_SECRET}"
    allow:
      - "github/*"
`
      );

      const strict = checkConfig(['--config', path, '--strict']);
      expect(strict.exitCode).toBe(1);
      expect(strict.text).toContain('AIRLOCK_TEST_SECRET');

      const structural = checkConfig(['--config', path, '--strict', '--no-resolve']);
      expect(structural.exitCode).toBe(0);
      expect(structural.data).toMatchObject({
        ok: true,
        resolveEnv: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not include resolved secrets in config check json payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-introspect-cli-secrets-'));
    try {
      const path = join(dir, 'airlock.yaml');
      writeFileSync(
        path,
        `
server:
  auth_required: true
  api_secret: "super-secret-api-token"
providers:
  github: builtin
agents:
  dev:
    token: "super-secret-agent-token"
    allow:
      - "github/*"
`
      );

      const result = checkConfig(['--config', path, '--json']);
      const payload = JSON.stringify(result.data);

      expect(result.exitCode).toBe(0);
      expect(payload).not.toContain('super-secret-api-token');
      expect(payload).not.toContain('super-secret-agent-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when config check finds an unknown security key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-introspect-cli-unknown-'));
    try {
      const path = join(dir, 'airlock.yaml');
      writeFileSync(
        path,
        `
providers:
  github: builtin
agents:
  dev:
    allow:
      - "github/*"
    scope:
      github_repo: airlock_repos
`
      );

      const result = checkConfig(['--config', path]);

      expect(result.exitCode).toBe(1);
      expect(result.text).toContain('Unrecognized key "scope" in agent "dev"');
      expect(result.text).toContain('Did you mean "arg_scope"?');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when a declared arg_scope has no effect', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-introspect-cli-noop-scope-'));
    try {
      const path = join(dir, 'airlock.yaml');
      writeFileSync(
        path,
        `
providers:
  github: builtin
value_sets:
  airlock_repos:
    - airlock-dev/airlock
arg_dimensions:
  github_repo:
    bindings: {}
agents:
  dev:
    allow:
      - "github/push_files"
    arg_scope:
      github_repo: airlock_repos
`
      );

      const result = checkConfig(['--config', path]);

      expect(result.exitCode).toBe(1);
      expect(result.text).toContain('resolves to zero effective argument constraints');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can gate YAML scalar warnings with --fail-on warn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-introspect-cli-footgun-'));
    try {
      const path = join(dir, 'airlock.yaml');
      writeFileSync(
        path,
        `
providers:
  sms: builtin
value_sets:
  allowed_numbers:
    - +16085153685
arg_dimensions:
  sms_recipient:
    normalize: [phone]
    bindings:
      sms/send: to
agents:
  dev:
    allow:
      - "sms/send"
    arg_scope:
      sms_recipient: allowed_numbers
`
      );

      const defaultResult = checkConfig(['--config', path]);
      const gatedResult = checkConfig(['--config', path, '--fail-on', 'warn']);

      expect(defaultResult.exitCode).toBe(0);
      expect(defaultResult.text).toContain('value 16085153685 looks like an unquoted string');
      expect(gatedResult.exitCode).toBe(1);
      expect(gatedResult.text).toContain('"+16085153685"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collapses info lint findings to per-rule summaries by default', () => {
    const result = lintYaml(INFO_ONLY_LINT_YAML);

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('Lint OK');
    expect(result.text).toContain('dead-deny: 4 (info) -');
    expect(result.text).toContain('... +1 more');
    expect(result.text).toContain('unused-profile: 1 (info) - github-write');
    expect(result.text).toContain('info collapsed; --verbose to list all');
    expect(result.text).not.toContain('  - [selene] deny pattern');
  });

  it('expands info lint findings with --verbose', () => {
    const result = lintYaml(INFO_ONLY_LINT_YAML, ['--verbose']);

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('dead-deny: 4 (info)');
    expect(result.text).toContain(
      '  - [selene] deny pattern "github/delete_repo" does not overlap any allow or ask pattern.'
    );
    expect(result.text).toContain(
      '  - [selene] deny pattern "github/merge_pull_request" does not overlap any allow or ask pattern.'
    );
    expect(result.text).not.toContain('info collapsed');
  });

  it('drops info lint summaries with --quiet', () => {
    const result = lintYaml(INFO_ONLY_LINT_YAML, ['--quiet']);

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('Lint OK (5 info hidden)');
    expect(result.text).not.toContain('dead-deny:');
    expect(result.text).not.toContain('unused-profile:');
  });

  it('silences lint rules with --disable and lint.disable', () => {
    const cliDisabled = lintYaml(INFO_ONLY_LINT_YAML, ['--disable', 'dead-deny,unused-profile']);
    expect(cliDisabled.exitCode).toBe(0);
    expect(cliDisabled.text).toBe('Lint OK');

    const configDisabled = lintYaml(`
lint:
  disable:
    - dead-deny
    - unused-profile
providers:
  github: builtin
profiles:
  github-write:
    allow:
      - "github/*"
agents:
  selene:
    allow:
      - "github/list_issues"
    deny:
      - "github/delete_repo"
`);
    expect(configDisabled.exitCode).toBe(0);
    expect(configDisabled.text).toBe('Lint OK');
  });

  it('re-grades lint rules with lint.severity and --rule overrides', () => {
    const configWarn = lintYaml(`
lint:
  severity:
    dead-deny: warn
providers:
  github: builtin
agents:
  selene:
    allow:
      - "github/list_issues"
    deny:
      - "github/delete_repo"
`);
    expect(configWarn.exitCode).toBe(1);
    expect(configWarn.text).toContain('dead-deny: 1 (warn)');

    const cliDowngrade = lintYaml(
      `
lint:
  severity:
    dead-deny: warn
providers:
  github: builtin
agents:
  selene:
    allow:
      - "github/list_issues"
    deny:
      - "github/delete_repo"
`,
      ['--rule', 'dead-deny=info']
    );
    expect(cliDowngrade.exitCode).toBe(0);
    expect(cliDowngrade.text).toContain('dead-deny: 1 (info)');
  });

  it('filters lint rules with --only and turns rules off with --rule', () => {
    const onlyDeadDeny = lintYaml(INFO_ONLY_LINT_YAML, ['--only', 'dead-deny']);
    expect(onlyDeadDeny.exitCode).toBe(0);
    expect(onlyDeadDeny.text).toContain('dead-deny: 4 (info)');
    expect(onlyDeadDeny.text).not.toContain('unused-profile');

    const ruleOff = lintYaml(INFO_ONLY_LINT_YAML, [
      '--only',
      'dead-deny',
      '--rule',
      'dead-deny=off',
    ]);
    expect(ruleOff.exitCode).toBe(0);
    expect(ruleOff.text).toBe('Lint OK');
  });

  it('flips the lint exit code with --fail-on info', () => {
    expect(lintYaml(INFO_ONLY_LINT_YAML).exitCode).toBe(0);
    expect(lintYaml(INFO_ONLY_LINT_YAML, ['--fail-on', 'info']).exitCode).toBe(1);
  });

  it('fails by default for warn-level empty-agent findings', () => {
    const result = lintYaml(`
agents:
  dev: {}
`);

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('empty-agent: 1 (warn)');
    expect(result.text).toContain('  - [dev] Agent has an empty effective allow/ask surface.');
  });

  it('reports missing environment references as warn-level lint findings without resolving them', () => {
    delete process.env['AIRLOCK_LINT_SECRET'];
    const result = lintYaml(`
server:
  auth_required: true
  api_secret: "\${AIRLOCK_LINT_SECRET}"
providers:
  github: builtin
agents:
  dev:
    token: "\${AIRLOCK_LINT_SECRET}"
    allow:
      - "github/*"
`);

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('missing-env-ref: 1 (warn)');
    expect(result.text).toContain(
      'Environment variable AIRLOCK_LINT_SECRET is referenced but not set.'
    );
  });

  it('maps unresolvable references to a controllable lint rule', () => {
    const yaml = `
agents:
  dev:
    extends:
      - missing
`;

    const defaultResult = lintYaml(yaml);
    expect(defaultResult.exitCode).toBe(1);
    expect(defaultResult.text).toContain('unresolvable-ref: 1 (warn)');
    expect(defaultResult.text).toContain('extends references unknown profile "missing"');

    const disabled = lintYaml(yaml, ['--disable', 'unresolvable-ref']);
    expect(disabled.exitCode).toBe(0);
    expect(disabled.text).toBe('Lint OK');

    const downgraded = lintYaml(yaml, ['--rule', 'unresolvable-ref=info']);
    expect(downgraded.exitCode).toBe(0);
    expect(downgraded.text).toContain('unresolvable-ref: 1 (info)');
  });

  it('emits grouped lint JSON by rule', () => {
    const result = lintYaml(INFO_ONLY_LINT_YAML, ['--json']);
    const payload = result.data as {
      rule: string;
      severity: string;
      count: number;
      findings: unknown[];
    }[];

    expect(result.exitCode).toBe(0);
    expect(payload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'dead-deny',
          severity: 'info',
          count: 4,
          findings: expect.any(Array),
        }),
        expect.objectContaining({
          rule: 'unused-profile',
          severity: 'info',
          count: 1,
          findings: expect.any(Array),
        }),
      ])
    );
  });
});
