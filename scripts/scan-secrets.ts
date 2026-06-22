#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { type SecretFinding, formatSecretFindings, scanSecrets } from '../src/security/secrets.js';

const MAX_FILE_BYTES = 1024 * 1024;

const args = new Set(process.argv.slice(2));
const stagedOnly = args.has('--staged');

if (!stagedOnly) {
  console.error('Usage: tsx scripts/scan-secrets.ts --staged');
  process.exit(2);
}

const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  .trim()
  .split('\n')
  .filter(Boolean);

const findings: SecretFinding[] = [];
const skipped: string[] = [];

for (const file of files) {
  const stagedPath = `:${file}`;
  const size = Number(git(['cat-file', '-s', stagedPath]).trim());
  if (size > MAX_FILE_BYTES) {
    skipped.push(`${file} (larger than ${MAX_FILE_BYTES} bytes)`);
    continue;
  }

  const content = gitBytes(['show', stagedPath]);

  if (!isLikelyText(content)) continue;

  findings.push(...scanSecrets(file, content.toString('utf8')));
}

if (findings.length > 0) {
  console.error(formatSecretFindings(findings));
  process.exit(1);
}

if (skipped.length > 0) {
  console.warn(
    `Secret scan skipped ${skipped.length} large staged file${skipped.length === 1 ? '' : 's'}:`
  );
  for (const file of skipped) {
    console.warn(`  ${file}`);
  }
}

console.log('Secret scan passed.');

function git(args: string[]): string {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }

  return result.stdout;
}

function gitBytes(args: string[]): Buffer {
  const result = spawnSync('git', args, {
    encoding: 'buffer',
    maxBuffer: MAX_FILE_BYTES + 1,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8') || `git ${args.join(' ')} failed`);
  }

  return result.stdout;
}

function isLikelyText(content: Buffer): boolean {
  if (content.includes(0)) return false;

  const sample = content.subarray(0, Math.min(content.length, 8192));
  let suspicious = 0;

  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    if (byte >= 128) continue;
    suspicious += 1;
  }

  return suspicious / Math.max(sample.length, 1) < 0.05;
}
