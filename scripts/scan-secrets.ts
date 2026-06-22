#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { type SecretFinding, formatSecretFindings, scanSecrets } from '../src/security/secrets.js';

const MAX_FILE_BYTES = 1024 * 1024;

const args = new Set(process.argv.slice(2));
const stagedOnly = args.has('--staged');
const allFiles = args.has('--all');

if (stagedOnly === allFiles) {
  console.error('Usage: tsx scripts/scan-secrets.ts --staged|--all');
  process.exit(2);
}

const findings: SecretFinding[] = [];
const skipped: string[] = [];

if (stagedOnly) {
  scanStagedFiles();
} else {
  scanWorkingTree();
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

function scanStagedFiles(): void {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .trim()
    .split('\n')
    .filter(Boolean);

  for (const file of files) {
    const stagedPath = `:${file}`;
    const size = Number(git(['cat-file', '-s', stagedPath]).trim());
    if (size > MAX_FILE_BYTES) {
      skipped.push(`${file} (larger than ${MAX_FILE_BYTES} bytes)`);
      continue;
    }

    scanFileContent(file, gitBytes(['show', stagedPath]));
  }
}

function scanWorkingTree(): void {
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);

  for (const file of files) {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }

    if (size > MAX_FILE_BYTES) {
      skipped.push(`${file} (larger than ${MAX_FILE_BYTES} bytes)`);
      continue;
    }

    scanFileContent(file, readFileSync(file));
  }
}

function scanFileContent(file: string, content: Buffer): void {
  if (!isLikelyText(content)) return;

  findings.push(...scanSecrets(file, content.toString('utf8')));
}

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
