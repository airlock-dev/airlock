import { describe, expect, it } from 'vitest';
import { formatSecretFindings, scanSecrets } from '../src/security/secrets.js';

describe('scanSecrets()', () => {
  it('detects provider-shaped secrets', () => {
    const key = `sk-proj-${'abcdefghijklmnopqrstuvwxyz'}1234567890`;
    const findings = scanSecrets('config.yaml', `openai_key: ${key}`);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('openai-key');
  });

  it('detects high-entropy generic secret assignments', () => {
    const key = `aB3_${'9xYzK2LmNoPq'}R7sTuVwX`;
    const findings = scanSecrets('config.yaml', `api_key: ${key}`);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('generic-secret-assignment');
  });

  it('allows environment placeholders and obvious fake values', () => {
    const findings = scanSecrets(
      'examples/gateway.yaml',
      [
        'api_secret: ${AIRLOCK_API_SECRET}',
        'token: your-openclaw-bearer-token',
        'password: changeme-password',
        'token: agent-secret',
      ].join('\n')
    );

    expect(findings).toEqual([]);
  });

  it('redacts findings in formatter output', () => {
    const secret = `github_pat_${'abcdefghijklmnopqrstuvwxyz'}1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
    const findings = scanSecrets('config.yaml', `token: ${secret}`);
    const output = formatSecretFindings(findings);

    expect(findings).toHaveLength(1);
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED');
  });
});
