import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { ResolvedSandboxConfig } from '../src/sandbox/index.js';
import { wrapCommandWithSandbox } from '../src/sandbox/index.js';

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function runSandboxed(command: string, sandbox: ResolvedSandboxConfig) {
  const wrapped = await wrapCommandWithSandbox(command, sandbox);

  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('/bin/sh', ['-c', wrapped], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function canReachExampleCom(): Promise<boolean> {
  const result = await new Promise<{ exitCode: number | null }>((resolve) => {
    const child = spawn('/usr/bin/curl', ['-I', '-sS', '-o', '/dev/null', 'https://example.com']);
    child.on('close', (exitCode) => resolve({ exitCode }));
    child.on('error', () => resolve({ exitCode: 1 }));
  });

  return result.exitCode === 0;
}

describeMac('sandbox runtime e2e smoke tests', () => {
  let rootDir: string;
  let allowedDir: string;
  let deniedDir: string;
  let allowedFile: string;
  let deniedFile: string;
  let baselineNetworkOkay = false;

  beforeAll(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'airlock-sandbox-e2e-'));
    allowedDir = join(rootDir, 'allowed');
    deniedDir = join(rootDir, 'denied');
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(deniedDir, { recursive: true });
    allowedFile = join(allowedDir, 'allowed.txt');
    deniedFile = join(deniedDir, 'denied.txt');

    writeFileSync(allowedFile, 'allowed');
    writeFileSync(deniedFile, 'denied');

    baselineNetworkOkay = await canReachExampleCom();
  });

  afterEach(async () => {
    await SandboxManager.reset();
  });

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  afterEach(() => {
    const writableFile = join(allowedDir, 'written.txt');
    const deniedWriteFile = join(process.cwd(), 'sandbox-denied-write.txt');
    if (existsSync(writableFile)) rmSync(writableFile, { force: true });
    if (existsSync(deniedWriteFile)) rmSync(deniedWriteFile, { force: true });
  });

  it('allows writes inside explicitly allowed directories', async () => {
    const writableFile = join(allowedDir, 'written.txt');
    const code = `from pathlib import Path; Path(${JSON.stringify(writableFile)}).write_text("ok")`;

    const result = await runSandboxed(`/usr/bin/python3 -c ${shellEscape(code)}`, {
      filesystem: {
        allow_write: [allowedDir],
        deny_read: [],
        deny_write: [],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(writableFile, 'utf8')).toBe('ok');
  });

  it('denies writes outside explicitly allowed directories', async () => {
    const deniedWriteFile = join(process.cwd(), 'sandbox-denied-write.txt');
    const code = `from pathlib import Path; Path(${JSON.stringify(deniedWriteFile)}).write_text("blocked")`;

    const result = await runSandboxed(`/usr/bin/python3 -c ${shellEscape(code)}`, {
      filesystem: {
        allow_write: [allowedDir],
        deny_read: [],
        deny_write: [],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Operation not permitted|Permission denied/);
    expect(existsSync(deniedWriteFile)).toBe(false);
  });

  it('denies reads from explicitly blocked paths', async () => {
    const result = await runSandboxed(`/bin/cat ${shellEscape(deniedFile)}`, {
      filesystem: {
        allow_write: [],
        deny_read: [deniedFile],
        deny_write: [],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Operation not permitted|Permission denied/);
  });

  it('re-allows reads inside denied regions via allow_read', async () => {
    const blockedNeighbor = join(allowedDir, 'blocked.txt');
    writeFileSync(blockedNeighbor, 'blocked');

    const allowedResult = await runSandboxed(`/bin/cat ${shellEscape(allowedFile)}`, {
      filesystem: {
        allow_write: [],
        deny_read: [allowedDir],
        deny_write: [],
        allow_read: [allowedFile],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    });

    const blockedResult = await runSandboxed(`/bin/cat ${shellEscape(blockedNeighbor)}`, {
      filesystem: {
        allow_write: [],
        deny_read: [allowedDir],
        deny_write: [],
        allow_read: [allowedFile],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    });

    expect(allowedResult.exitCode).toBe(0);
    expect(allowedResult.stdout.trim()).toBe('allowed');
    expect(blockedResult.exitCode).not.toBe(0);
    expect(blockedResult.stderr).toMatch(/Operation not permitted|Permission denied/);

    rmSync(blockedNeighbor, { force: true });
  });

  it('blocks outbound network when no domains are allowed', async () => {
    const result = await runSandboxed('/usr/bin/curl -I -sS -o /dev/null https://example.com', {
      filesystem: {
        allow_write: [],
        deny_read: [],
        deny_write: [],
      },
      network: {
        allowed_domains: [],
        denied_domains: [],
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(
      /Operation not permitted|Permission denied|timed out|Network is unreachable|Could not resolve host|Could not connect|response 403/
    );
  });

  it('allows outbound network to explicitly allowed domains', async () => {
    if (!baselineNetworkOkay) {
      return;
    }

    const result = await runSandboxed(
      '/usr/bin/curl -I -sS -o /dev/null -w "%{http_code}" https://example.com',
      {
        filesystem: {
          allow_write: [],
          deny_read: [],
          deny_write: [],
        },
        network: {
          allowed_domains: ['example.com'],
          denied_domains: [],
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('200');
  });
});
