import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyProfiles } from '../src/config/profiles.js';
import { GatewayConfig } from '../src/config/schema.js';
import { checkConfig, whoCan } from '../src/introspect/cli.js';

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
});
