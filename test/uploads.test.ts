import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import Fastify from 'fastify';
import { lookup } from 'dns/promises';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/client';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import {
  GatewayConfig,
  UploadsConfig,
  type AgentConfig,
  type SecurityConfig,
} from '../src/config/schema.js';
import { loadConfigDetailed } from '../src/config/loader.js';
import { applyProfiles } from '../src/config/profiles.js';
import {
  annotateUploadArgs,
  findUploadRefs,
  formatByteSize,
  inferMimeType,
  matchesMimeAllowlist,
  parseUploadRef,
  replaceUploadRefs,
  sanitizeFilename,
} from '../src/uploads/refs.js';
import { assertUploadPlanActive, matchToolUploadRule } from '../src/uploads/resolve.js';
import { UploadHttpError, UploadStore } from '../src/uploads/store.js';
import { uploadsApiPlugin } from '../src/uploads/api.js';
import { formatNotification } from '../src/hitl/formatter.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { ToolRegistry } from '../src/registry/registry.js';
import { AirlockBackendAdapter } from '../src/backend/airlock-adapter.js';
import { HttpBackendAdapter } from '../src/backend/http-adapter.js';
import { OpenApiAdapter } from '../src/backend/openapi/adapter.js';
import { McpBackendAdapter } from '../src/backend/mcp-adapter.js';
import { CliBackendAdapter } from '../src/backend/cli/adapter.js';
import { buildMiddlewareChain } from '../src/middleware/chain-builder.js';
import type { ToolCallContext } from '../src/middleware/types.js';
import { AuditLogger } from '../src/audit/logger.js';
import { HitlEngine } from '../src/hitl/engine.js';
import { HitlBatcher } from '../src/hitl/batcher.js';
import type { HitlNotification, HitlProvider } from '../src/hitl/providers/types.js';
import type { ClientPool } from '../src/pool/pool.js';
import { StdioMcpClient } from '../src/pool/stdio-client.js';
import { Gateway } from '../src/gateway.js';

vi.mock('dns/promises', () => ({ lookup: vi.fn() }));
const lookupMock = vi.mocked(lookup);

function makeUploadsConfig(dir: string, overrides: Partial<UploadsConfig> = {}): UploadsConfig {
  return UploadsConfig.parse({
    enabled: true,
    dir,
    public_url: 'https://airlock.example.com',
    ...overrides,
  });
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return GatewayConfig.parse({
    agents: {
      a1: overrides,
    },
  }).agents.a1;
}

const DEFAULT_SECURITY: SecurityConfig = {
  blocked_hosts: ['localhost', '127.0.0.1', '::1', '*.local', '10.*', '192.168.*'],
  allowed_local: [],
};

function makeNoopProvider(captured: HitlNotification[]): HitlProvider {
  return {
    name: 'mock',
    async init() {},
    async notify(req) {
      captured.push(req);
    },
    async stop() {},
  };
}

describe('uploads/refs', () => {
  it('parses valid upload refs with and without delivery mode', () => {
    const id = 'upl_x7kP9mQ2vR4tW8yZ3bN5cD';
    expect(parseUploadRef(`airlock-upload://${id}`)).toEqual({
      raw: `airlock-upload://${id}`,
      id,
    });
    expect(parseUploadRef(`airlock-upload://${id}:base64`)).toEqual({
      raw: `airlock-upload://${id}:base64`,
      id,
      mode: 'base64',
    });
    expect(parseUploadRef(`airlock-upload://${id}:path`)).toEqual({
      raw: `airlock-upload://${id}:path`,
      id,
      mode: 'path',
    });
    expect(parseUploadRef(`airlock-upload://${id}:unknown`)).toBeUndefined();
    expect(parseUploadRef('airlock-upload://upl_short')).toBeUndefined();
    expect(parseUploadRef('airlock-upload://not-a-valid-id')).toBeUndefined();
    expect(parseUploadRef('https://example.com')).toBeUndefined();
  });

  it('finds upload refs nested inside objects and arrays', () => {
    const id = 'upl_x7kP9mQ2vR4tW8yZ3bN5cD';
    const found = findUploadRefs({
      file: `airlock-upload://${id}`,
      nested: { items: [`airlock-upload://${id}:base64`, 'airlock-upload://bogus'] },
      plain: 'hello',
    });
    expect(found).toHaveLength(3);
    expect(found[0]).toMatchObject({ path: 'file', topKey: 'file', parsed: { id } });
    expect(found[1]).toMatchObject({
      path: 'nested.items[0]',
      topKey: 'nested',
      parsed: { id, mode: 'base64' },
    });
    expect(found[2]).toMatchObject({
      path: 'nested.items[1]',
      topKey: 'nested',
      parsed: undefined,
    });
  });

  it('sanitizes dangerous filenames and prevents traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\charles\\part.3mf')).toBe('part.3mf');
    expect(sanitizeFilename('..')).toBe('upload.bin');
    expect(sanitizeFilename('.hidden.3mf')).toBe('hidden.3mf');
    expect(sanitizeFilename('bad\x00"name;rm.png')).toBe('badnamerm.png');
    expect(sanitizeFilename('')).toBe('upload.bin');
  });

  it('infers MIME types including 3D print formats and matches allowlists', () => {
    expect(inferMimeType('bracket.3mf')).toBe('model/3mf');
    expect(inferMimeType('bracket.3mf', 'application/octet-stream')).toBe('model/3mf');
    expect(inferMimeType('shot.png')).toBe('image/png');
    expect(inferMimeType('custom.bin', 'application/vnd.custom+bin')).toBe(
      'application/vnd.custom+bin'
    );

    expect(matchesMimeAllowlist('model/3mf', [])).toBe(true);
    expect(matchesMimeAllowlist('model/3mf', ['model/*', 'image/png'])).toBe(true);
    expect(matchesMimeAllowlist('application/pdf', ['model/*', 'image/*'])).toBe(false);
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1536)).toBe('1.5 KB');
  });

  it('annotates upload refs for HITL display without mutating original args', () => {
    const id = 'upl_x7kP9mQ2vR4tW8yZ3bN5cD';
    const original = { file: `airlock-upload://${id}`, printer_id: 2 };
    const annotated = annotateUploadArgs(original, () => 'bracket.3mf, 1.4 MB');
    expect(annotated).toEqual({
      file: `airlock-upload://${id} (bracket.3mf, 1.4 MB)`,
      printer_id: 2,
    });
    expect(original.file).toBe(`airlock-upload://${id}`);
  });
});

describe('UploadStore', () => {
  let workDir: string;
  let store: UploadStore;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'airlock-upload-store-'));
    store = new UploadStore(makeUploadsConfig(workDir));
  });

  afterEach(async () => {
    await store.stop();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('prepares, completes raw binary upload, reads bytes, and enforces single-use ticket', async () => {
    const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]);
    const expectedHash = createHash('sha256').update(payload).digest('hex');

    const prepared = store.prepareUpload('agent-a', { filename: 'bracket.3mf' });
    expect(prepared.uploadUrl).toBe(`https://airlock.example.com/uploads/${prepared.uploadToken}`);
    expect(prepared.contentType).toBe('model/3mf');

    const completed = await store.completePresignedUpload(prepared.uploadToken, {
      stream: Readable.from([payload]),
    });

    expect(completed.upload_id).toBe(prepared.uploadId);
    expect(completed.size_bytes).toBe(payload.length);
    expect(completed.sha256).toBe(expectedHash);
    expect(completed.content_type).toBe('model/3mf');

    // Second attempt with the same token must fail
    await expect(
      store.completePresignedUpload(prepared.uploadToken, {
        stream: Readable.from([payload]),
      })
    ).rejects.toThrow(UploadHttpError);

    // Owner can read bytes; another agent cannot
    const read = await store.readBytes('agent-a', prepared.uploadId);
    expect(read.bytes.equals(payload)).toBe(true);
    await expect(store.readBytes('agent-b', prepared.uploadId)).rejects.toThrow(/not found/i);
  });

  it('accepts multipart/form-data on presigned upload URLs (e.g. curl -F)', async () => {
    const prepared = store.prepareUpload('agent-a', { filename: 'upload.bin' });
    const form = new FormData();
    const content = Buffer.from('hello from multipart');
    form.append('file', new File([content], 'report.txt', { type: 'text/plain' }));
    const req = new Request('http://local/upload', { method: 'POST', body: form });
    const rawBuf = Buffer.from(await req.arrayBuffer());

    const completed = await store.completePresignedUpload(prepared.uploadToken, {
      stream: Readable.from([rawBuf]),
      contentTypeHeader: req.headers.get('content-type') ?? undefined,
    });

    expect(completed.size_bytes).toBe(content.length);
    const read = await store.readBytes('agent-a', prepared.uploadId);
    expect(read.bytes.toString('utf8')).toBe('hello from multipart');
  });

  it('enforces max_file_bytes during streaming and cleans up temp files', async () => {
    await store.stop();
    store = new UploadStore(makeUploadsConfig(workDir, { max_file_bytes: 10 }));

    const prepared = store.prepareUpload('agent-a', { filename: 'big.bin' });
    await expect(
      store.completePresignedUpload(prepared.uploadToken, {
        stream: Readable.from([Buffer.alloc(16, 0x41)]),
      })
    ).rejects.toMatchObject({ statusCode: 413 });

    expect(store.getUploadAnyStatus('agent-a', prepared.uploadId)).toBeUndefined();
  });

  it('pins in-flight uploads against TTL eviction and explicit deletion', async () => {
    await store.stop();
    store = new UploadStore(makeUploadsConfig(workDir, { ttl_ms: 50 }));

    const prepared = store.prepareUpload('agent-a', { filename: 'hold.txt' });
    await store.completePresignedUpload(prepared.uploadToken, {
      stream: Readable.from([Buffer.from('pinned')]),
    });

    const unpin = store.pin('agent-a', [prepared.uploadId]);
    await new Promise((r) => setTimeout(r, 70));
    store.sweepExpired();

    // Still present while pinned
    expect(store.getReadyUpload('agent-a', prepared.uploadId)).toBeDefined();
    expect(() => store.deleteUpload('agent-a', prepared.uploadId)).toThrow(/currently in use/i);

    unpin();
    store.sweepExpired();
    expect(store.getReadyUpload('agent-a', prepared.uploadId)).toBeUndefined();
  });

  it('mints one-time download URLs where HEAD does not consume and GET consumes once', async () => {
    await store.stop();
    store = new UploadStore(
      makeUploadsConfig(workDir, {
        public_url: 'https://public.example.com',
        internal_url: 'http://airlock-internal:4111',
      })
    );

    const prepared = store.prepareUpload('agent-a', { filename: 'doc.pdf' });
    await store.completePresignedUpload(prepared.uploadToken, {
      stream: Readable.from([Buffer.from('%PDF-1.7')]),
    });

    const dl = store.mintDownloadUrl('agent-a', prepared.uploadId);
    expect(dl.downloadUrl.startsWith('http://airlock-internal:4111/uploads/dl/')).toBe(true);
    const token = dl.downloadPath.replace('/uploads/dl/', '');

    // HEAD peeks without consuming
    expect((await store.openDownload(token, false))?.record.filename).toBe('doc.pdf');
    // First GET succeeds and consumes
    const opened = await store.openDownload(token, true);
    expect(opened?.record.filename).toBe('doc.pdf');
    opened?.stream?.destroy();
    // Second GET fails
    expect(await store.openDownload(token, true)).toBeUndefined();
  });

  it('preserves unrelated files in staging dir on stop()', async () => {
    const unrelated = join(workDir, 'keep-me.txt');
    writeFileSync(unrelated, 'keep');

    const prepared = store.prepareUpload('agent-a', { filename: 'temp.bin' });
    await store.completePresignedUpload(prepared.uploadToken, {
      stream: Readable.from([Buffer.from('temp')]),
    });
    const stagedDir = join(workDir, prepared.uploadId);
    expect(existsSync(stagedDir)).toBe(true);

    await store.stop();
    expect(existsSync(stagedDir)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('resolves multi-hostname public_urls by requestHost, ignores spoofed hosts, and honors per-agent public_url', async () => {
    await store.stop();
    store = new UploadStore(
      makeUploadsConfig(workDir, {
        public_url: undefined,
        public_urls: ['https://airlock-mcp.chrls.dev', 'https://airlock-mcp.merino-snares.ts.net'],
      })
    );

    const viaTraefik = store.prepareUpload('laptop', {
      filename: 'shot.png',
      requestHost: 'airlock-mcp.chrls.dev',
    });
    expect(viaTraefik.uploadUrl.startsWith('https://airlock-mcp.chrls.dev/uploads/')).toBe(true);

    const viaTailscale = store.prepareUpload('charon', {
      filename: 'part.3mf',
      requestHost: 'airlock-mcp.merino-snares.ts.net:443',
    });
    expect(
      viaTailscale.uploadUrl.startsWith('https://airlock-mcp.merino-snares.ts.net/uploads/')
    ).toBe(true);

    // Spoofed Host header falls back to first allowlisted URL
    const spoofed = store.prepareUpload('charon', {
      filename: 'evil.png',
      requestHost: 'attacker.evil.example',
    });
    expect(spoofed.uploadUrl.startsWith('https://airlock-mcp.chrls.dev/uploads/')).toBe(true);

    // Per-agent public_url pin takes priority over requestHost
    const pinned = store.prepareUpload('charon', {
      filename: 'pinned.3mf',
      requestHost: 'airlock-mcp.chrls.dev',
      agentLimits: { public_url: 'https://airlock-mcp.merino-snares.ts.net' },
    });
    expect(pinned.uploadUrl.startsWith('https://airlock-mcp.merino-snares.ts.net/uploads/')).toBe(
      true
    );
  });

  it('allows per-agent max_file_bytes above the global default up to max_total_bytes', async () => {
    await store.stop();
    store = new UploadStore(
      makeUploadsConfig(workDir, {
        max_file_bytes: 100,
        max_total_bytes: 500,
      })
    );

    // Default agent is capped at 100 bytes
    expect(() => store.prepareUpload('standard', { filename: 'vid.mp4', sizeBytes: 250 })).toThrow(
      /exceeds limit of 100/
    );

    // Video agent can raise above default (250 <= 400 <= 500 max_total_bytes)
    const allowed = store.prepareUpload('autovideo', {
      filename: 'vid.mp4',
      sizeBytes: 250,
      agentLimits: { max_file_bytes: 400 },
    });
    expect(allowed.maxBytes).toBe(400);

    // Even a higher per-agent override is still bounded by global max_total_bytes
    const capped = store.prepareUpload('autovideo', {
      filename: 'huge.mp4',
      agentLimits: { max_file_bytes: 9999 },
    });
    expect(capped.maxBytes).toBe(500);
  });

  it('aborts stalled uploads with 408 and cleans up staging', async () => {
    await store.stop();
    store = new UploadStore(makeUploadsConfig(workDir), 'http://127.0.0.1:4111', {
      streamIdleTimeoutMs: 40,
    });

    const prepared = store.prepareUpload('agent-a', { filename: 'stall.bin' });
    const stalledStream = new Readable({ read() {} });
    await expect(
      store.completePresignedUpload(prepared.uploadToken, { stream: stalledStream })
    ).rejects.toMatchObject({ statusCode: 408 });

    expect(store.getUploadAnyStatus('agent-a', prepared.uploadId)).toBeUndefined();
  });

  it('issues 128-bit base64url capability upload IDs, defaults max_files_per_agent to 100, and isolates sessions sharing an agent profile', async () => {
    expect(UploadsConfig.parse({}).max_files_per_agent).toBe(100);

    await store.stop();
    store = new UploadStore(makeUploadsConfig(workDir, { max_files_per_agent: 1 }));

    const s1 = store.prepareUpload('amoura', { filename: 'a.png', sessionId: 'sess-1' });
    expect(s1.uploadId).toMatch(/^upl_[A-Za-z0-9_-]{22}$/);
    await store.completePresignedUpload(s1.uploadToken, {
      stream: Readable.from([Buffer.from('thread-1')]),
    });

    // Separate session on the same agent profile gets its own max_files quota
    const s2 = store.prepareUpload('amoura', { filename: 'a.png', sessionId: 'sess-2' });
    await store.completePresignedUpload(s2.uploadToken, {
      stream: Readable.from([Buffer.from('thread-2')]),
    });

    // Session 1 cannot read, mint download, or delete Session 2's upload (and vice versa)
    expect((await store.readBytes('amoura', s1.uploadId, 'sess-1')).bytes.toString()).toBe(
      'thread-1'
    );
    await expect(store.readBytes('amoura', s2.uploadId, 'sess-1')).rejects.toThrow(/not found/i);
    await expect(store.readBytes('amoura', s1.uploadId)).rejects.toThrow(/not found/i);
    expect(store.deleteUpload('amoura', s2.uploadId, 'sess-1')).toBe(false);
    expect(store.deleteUpload('amoura', s1.uploadId)).toBe(false);

    // Download ticket minted by Session 1 opens cleanly without leaking to other sessions
    const dl = store.mintDownloadUrl('amoura', s1.uploadId, 'sess-1');
    const token = dl.downloadPath.replace('/uploads/dl/', '');
    const opened = await store.openDownload(token, true);
    expect(opened?.record.id).toBe(s1.uploadId);
    opened?.stream?.destroy();

    // Owner session can delete its own upload
    expect(store.deleteUpload('amoura', s1.uploadId, 'sess-1')).toBe(true);

    // AirlockBackendAdapter exposes prepare_upload and delete_upload, never a cross-thread list tool
    const adapter = new AirlockBackendAdapter({ uploadStore: store });
    const toolNames = (await adapter.listTools()).map((t) => t.name);
    expect(toolNames).toContain('airlock/prepare_upload');
    expect(toolNames).toContain('airlock/delete_upload');
    expect(toolNames).not.toContain('airlock/list_uploads');

    // H8: returned curl instructions use a fixed placeholder path, never caller filename shell syntax
    const tricky = await adapter.call({
      tool: 'airlock/prepare_upload',
      agentId: 'amoura',
      args: { filename: 'my $(id) file.png' },
    });
    expect(tricky.success).toBe(true);
    const trickyData = tricky.data as { filename: string; instructions: string };
    expect(trickyData.filename).toBe('my $(id) file.png');
    expect(trickyData.instructions).not.toContain('$(id)');
    expect(trickyData.instructions).toContain('@/path/to/file');
  });

  it('isolates default temp directories across stores, enforces live concurrent max_total_bytes, and streams chunked multipart', async () => {
    // H1: two stores with no explicit dir get separate temp dirs and BOTH hold the OS exclusive lock
    // (even another process explicitly targeting storeA's temp dir cannot acquire it or sweep files)
    const storeA = new UploadStore(UploadsConfig.parse({ enabled: true }));
    const storeB = new UploadStore(UploadsConfig.parse({ enabled: true }));
    try {
      expect(storeA.getStagingDir()).not.toBe(storeB.getStagingDir());
      const a = storeA.prepareUpload('a', { filename: 'keep.txt' });
      await storeA.completePresignedUpload(a.uploadToken, {
        stream: Readable.from([Buffer.from('alive')]),
      });
      await storeB.stop();
      // Even a separate OS process pointing explicit uploads.dir at storeA's auto temp dir fails
      const probeScript = `
        import { UploadStore } from ${JSON.stringify(new URL('../src/uploads/store.ts', import.meta.url).href)};
        import { UploadsConfig } from ${JSON.stringify(new URL('../src/config/schema.ts', import.meta.url).href)};
        try {
          new UploadStore(UploadsConfig.parse({ enabled: true, dir: process.argv[1] }));
          process.stdout.write('ACQUIRED\\n');
        } catch (err) {
          process.stdout.write('BLOCKED:' + (err instanceof Error ? err.message : String(err)) + '\\n');
        }
      `;
      const probeResult = await new Promise<string>((resolveOut) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '-e', probeScript, storeA.getStagingDir()],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.once('exit', () => resolveOut(out.trim()));
      });
      expect(probeResult).toMatch(/^BLOCKED:.*already owned/i);
      expect((await storeA.readBytes('a', a.uploadId)).bytes.toString()).toBe('alive');
    } finally {
      await storeA.stop();
      await storeB.stop();
    }

    // H1: explicit uploads.dir requires an OS-held exclusive lock across both in-process and
    // separate processes (concurrent starters cannot race, and SIGKILL releases the kernel lock).
    const sharedDir = mkdtempSync(join(tmpdir(), 'airlock-shared-dir-'));
    const storeModuleUrl = new URL('../src/uploads/store.ts', import.meta.url).href;
    const schemaModuleUrl = new URL('../src/config/schema.ts', import.meta.url).href;
    const s1 = new UploadStore(makeUploadsConfig(sharedDir));
    try {
      const p1 = s1.prepareUpload('a', { filename: 'active.bin' });
      await s1.completePresignedUpload(p1.uploadToken, {
        stream: Readable.from([Buffer.from('still-active')]),
      });
      // Same-process second store on the same directory is rejected immediately
      expect(() => new UploadStore(makeUploadsConfig(sharedDir))).toThrow(
        /already owned by another active Airlock instance/i
      );
      expect((await s1.readBytes('a', p1.uploadId)).bytes.toString()).toBe('still-active');
    } finally {
      await s1.stop();
    }

    // Separate-process lock test: spawn node directly with tsx loader (no wrapper child) so
    // SIGKILL terminates the exact lock-holding process cleanly.
    const holderScript = `
      import { UploadStore } from ${JSON.stringify(storeModuleUrl)};
      import { UploadsConfig } from ${JSON.stringify(schemaModuleUrl)};
      const dir = process.argv[1];
      const store = new UploadStore(UploadsConfig.parse({ enabled: true, dir }));
      process.stdout.write('READY\\n');
      setInterval(() => {}, 10_000);
    `;
    const holder = spawn(process.execPath, ['--import', 'tsx', '-e', holderScript, sharedDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        let out = '';
        let err = '';
        holder.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('READY')) resolveReady();
        });
        holder.stderr.on('data', (chunk: Buffer) => {
          err += chunk.toString();
        });
        holder.once('exit', (code) => {
          if (!out.includes('READY')) {
            rejectReady(new Error(`Holder exited early (${code}): ${err}`));
          }
        });
      });

      // Live child holds the OS exclusive lock -> parent store startup MUST fail
      expect(() => new UploadStore(makeUploadsConfig(sharedDir))).toThrow(
        /already owned by another active Airlock instance/i
      );

      // Kill holder with SIGKILL (no graceful cleanup) -> OS releases lock automatically
      const holderExited = new Promise<void>((resolveExit) => {
        holder.once('exit', () => resolveExit());
      });
      holder.kill('SIGKILL');
      await holderExited;

      // Drop an orphan dir and race TWO separate processes simultaneously on the same directory
      const orphanDir = join(sharedDir, 'upl_0123456789abcdefghijkl');
      mkdirSync(orphanDir, { recursive: true });
      writeFileSync(join(orphanDir, 'stale.bin'), 'orphan');

      const racerScript = `
        import { UploadStore } from ${JSON.stringify(storeModuleUrl)};
        import { UploadsConfig } from ${JSON.stringify(schemaModuleUrl)};
        const dir = process.argv[1];
        (async () => {
          try {
            const store = new UploadStore(UploadsConfig.parse({ enabled: true, dir }));
            process.stdout.write('WON\\n');
            await new Promise((r) => setTimeout(r, 400));
            await store.stop();
          } catch (err) {
            process.stdout.write('BUSY:' + (err instanceof Error ? err.message : String(err)) + '\\n');
          }
        })();
      `;
      const runRacer = () =>
        new Promise<string>((resolveOut) => {
          const child = spawn(process.execPath, ['--import', 'tsx', '-e', racerScript, sharedDir], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          let errOut = '';
          child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
          });
          child.stderr.on('data', (chunk: Buffer) => {
            errOut += chunk.toString();
          });
          child.once('exit', () => resolveOut(out.trim() || `ERR:${errOut.trim()}`));
        });
      const [racerA, racerB] = await Promise.all([runRacer(), runRacer()]);
      const winners = [racerA, racerB].filter((o) => o === 'WON');
      const losers = [racerA, racerB].filter((o) => o.startsWith('BUSY:'));
      expect(winners, JSON.stringify([racerA, racerB])).toHaveLength(1);
      expect(losers, JSON.stringify([racerA, racerB])).toHaveLength(1);
      expect(existsSync(orphanDir)).toBe(false);
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL');
      rmSync(sharedDir, { recursive: true, force: true });
    }

    // H2: two concurrent uploads racing for max_total_bytes cannot exceed the budget
    await store.stop();
    store = new UploadStore(
      makeUploadsConfig(workDir, { max_file_bytes: 100, max_total_bytes: 120 })
    );
    const t1 = store.prepareUpload('a', { filename: 'one.bin' });
    const t2 = store.prepareUpload('a', { filename: 'two.bin' });

    const stream1 = new Readable({ read() {} });
    const stream2 = new Readable({ read() {} });
    const pOne = store.completePresignedUpload(t1.uploadToken, { stream: stream1 });
    const pTwo = store.completePresignedUpload(t2.uploadToken, { stream: stream2 });

    // H7: deleting an actively uploading record is rejected
    expect(() => store.deleteUpload('a', t1.uploadId)).toThrow(/currently uploading/i);

    stream1.push(Buffer.alloc(80, 0x41));
    await new Promise((r) => setTimeout(r, 10));
    stream2.push(Buffer.alloc(80, 0x42));
    stream1.push(null);
    stream2.push(null);

    const results = await Promise.allSettled([pOne, pTwo]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 507 });

    // H3: streaming multipart parser handles tiny 7-byte chunks splitting boundaries across packets
    await store.stop();
    store = new UploadStore(makeUploadsConfig(workDir));
    const mp = store.prepareUpload('a', { filename: 'upload.bin' });
    const form = new FormData();
    const content = Buffer.from('0123456789abcdef-multipart-streamed-payload!');
    form.append('note', 'ignore-me');
    form.append('file', new File([content], 'split.txt', { type: 'text/plain' }));
    const req = new Request('http://local/upload', { method: 'POST', body: form });
    const rawBuf = Buffer.from(await req.arrayBuffer());
    const tinyChunks: Buffer[] = [];
    for (let i = 0; i < rawBuf.byteLength; i += 7) {
      tinyChunks.push(rawBuf.subarray(i, i + 7));
    }
    const mpDone = await store.completePresignedUpload(mp.uploadToken, {
      stream: Readable.from(tinyChunks),
      contentTypeHeader: req.headers.get('content-type') ?? undefined,
    });
    expect(mpDone.size_bytes).toBe(content.length);
    expect((await store.readBytes('a', mp.uploadId)).bytes.equals(content)).toBe(true);

    // H4: post-upload disk tampering (even same-size) fails verification on readBytes AND streaming downloads
    const rec = store.getReadyUpload('a', mp.uploadId)!;
    writeFileSync(rec.diskPath, Buffer.alloc(content.length, 0xff));
    await expect(store.readBytes('a', mp.uploadId)).rejects.toThrow(/metadata changed|integrity/i);
    await expect(store.openVerifiedStream('a', mp.uploadId)).rejects.toThrow(
      /metadata changed|integrity/i
    );

    // H2: active GET download pins record against delete and TTL eviction until stream closes
    await store.stop();
    store = new UploadStore(makeUploadsConfig(workDir, { ttl_ms: 40 }));
    const dlPrep = store.prepareUpload('a', { filename: 'stream.bin' });
    await store.completePresignedUpload(dlPrep.uploadToken, {
      stream: Readable.from([Buffer.from('pinned-by-download')]),
    });
    const dlInfo = store.mintDownloadUrl('a', dlPrep.uploadId);
    const dlTok = dlInfo.downloadPath.replace('/uploads/dl/', '');
    const activeDl = await store.openDownload(dlTok, true);
    expect(activeDl?.stream).toBeDefined();
    expect(() => store.deleteUpload('a', dlPrep.uploadId)).toThrow(/currently in use/i);
    await new Promise((r) => setTimeout(r, 60));
    store.sweepExpired();
    expect(store.getReadyUpload('a', dlPrep.uploadId)).toBeDefined();
    activeDl!.stream!.destroy();
    store.sweepExpired();
    expect(store.getReadyUpload('a', dlPrep.uploadId)).toBeUndefined();

    // Low H3: truncated multipart (missing closing --boundary-- after first file part) fails with 400
    await store.stop();
    store = new UploadStore(makeUploadsConfig(workDir));
    const truncPrep = store.prepareUpload('a', { filename: 'trunc.txt' });
    const truncBoundary = '----TruncBoundary123';
    const truncBody = Buffer.from(
      `--${truncBoundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="trunc.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n` +
        `hello\r\n` +
        `--${truncBoundary}\r\n` +
        `Content-Disposition: form-data; name="trailing"\r\n\r\n` +
        `cut-off-without-closing-boundary`
    );
    await expect(
      store.completePresignedUpload(truncPrep.uploadToken, {
        stream: Readable.from([truncBody]),
        contentTypeHeader: `multipart/form-data; boundary=${truncBoundary}`,
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    // M1: aggregate record cap prevents unbounded session churn AND applies to sessionless callers too
    await store.stop();
    store = new UploadStore(makeUploadsConfig(workDir, { max_files_per_agent: 1 }));
    for (let i = 0; i < 4; i += 1) {
      store.prepareUpload('churn', { filename: `f${i}.txt`, sessionId: `s-${i}` });
    }
    expect(() =>
      store.prepareUpload('churn', { filename: 'overflow.txt', sessionId: 's-4' })
    ).toThrow(/across all sessions/i);
    expect(() => store.prepareUpload('churn', { filename: 'sessionless-overflow.txt' })).toThrow(
      /across all sessions/i
    );
  });
});

describe('uploadsApiPlugin (HTTP data-plane routes)', () => {
  let workDir: string;
  let store: UploadStore;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'airlock-uploads-api-'));
    store = new UploadStore(makeUploadsConfig(workDir, { max_file_bytes: 1024 }));
    const agents = {
      allowedAgent: makeAgentConfig({
        token: 'tok-allowed',
        allow: ['airlock/prepare_upload', 'airlock/delete_upload'],
      }),
      noDeleteAgent: makeAgentConfig({
        token: 'tok-nodelete',
        allow: ['airlock/prepare_upload'],
        deny: ['airlock/delete_upload'],
      }),
      askDeleteAgent: makeAgentConfig({
        token: 'tok-askdelete',
        allow: ['airlock/prepare_upload'],
        ask: ['airlock/delete_upload'],
      }),
      askAgent: makeAgentConfig({
        token: 'tok-ask',
        ask: ['airlock/prepare_upload'],
      }),
      deniedAgent: makeAgentConfig({
        token: 'tok-denied',
        allow: ['http/get'],
      }),
    };
    const allowlist = new AllowlistEngine(agents);

    app = Fastify({ logger: false });
    await app.register(uploadsApiPlugin, {
      uploadStore: store,
      getAgentConfig: (id) => agents[id as keyof typeof agents],
      allowlist,
      authRequired: true,
      allowedOrigins: ['https://trusted.example.com'],
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    store.setRuntimeBaseUrl(`http://127.0.0.1:${addr.port}`);
  });

  afterEach(async () => {
    await app.close();
    await store.stop();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('supports presigned PUT upload and one-time HEAD + GET download over real HTTP', async () => {
    const addr = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    const prepared = store.prepareUpload('allowedAgent', { filename: 'cube.3mf' });
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

    // Blocked browser origin rejected
    const badOrigin = await fetch(`${base}${prepared.uploadPath}`, {
      method: 'PUT',
      headers: { Origin: 'https://evil.example.com' },
      body: bytes,
    });
    expect(badOrigin.status).toBe(403);

    // Non-browser curl-style PUT succeeds without bearer auth
    const putRes = await fetch(`${base}${prepared.uploadPath}`, {
      method: 'PUT',
      body: bytes,
    });
    expect(putRes.status).toBe(201);
    const body = (await putRes.json()) as {
      upload_id: string;
      size_bytes: number;
      content_type: string;
    };
    expect(body.upload_id).toBe(prepared.uploadId);
    expect(body.size_bytes).toBe(8);
    expect(body.content_type).toBe('model/3mf');

    // Replay rejected
    const replay = await fetch(`${base}${prepared.uploadPath}`, { method: 'PUT', body: bytes });
    expect(replay.status).toBe(404);

    // One-time download URL
    const dl = store.mintDownloadUrl('allowedAgent', prepared.uploadId);
    const headRes = await fetch(`${base}${dl.downloadPath}`, { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-length')).toBe('8');
    expect(headRes.headers.get('x-content-type-options')).toBe('nosniff');

    const getRes = await fetch(`${base}${dl.downloadPath}`);
    expect(getRes.status).toBe(200);
    expect(Buffer.from(await getRes.arrayBuffer()).equals(bytes)).toBe(true);

    // Second GET consumed
    const secondGet = await fetch(`${base}${dl.downloadPath}`);
    expect(secondGet.status).toBe(404);
  });

  it('enforces agent bearer auth and allowlist on direct POST/DELETE /agents/:id/uploads', async () => {
    const addr = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    // Missing token -> 401
    const unauth = await fetch(`${base}/agents/allowedAgent/uploads`, {
      method: 'POST',
      body: 'abc',
    });
    expect(unauth.status).toBe(401);

    // Denied agent -> 403
    const denied = await fetch(`${base}/agents/deniedAgent/uploads`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-denied' },
      body: 'abc',
    });
    expect(denied.status).toBe(403);

    // Ask-gated agent -> 403 (must go through MCP approval)
    const askBlocked = await fetch(`${base}/agents/askAgent/uploads`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-ask' },
      body: 'abc',
    });
    expect(askBlocked.status).toBe(403);

    // Allowed agent -> 201
    const ok = await fetch(`${base}/agents/allowedAgent/uploads`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok-allowed',
        'X-Filename': 'note.txt',
      },
      body: 'hello world',
    });
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as { upload_id: string; filename: string };
    expect(created.filename).toBe('note.txt');

    // Delete works for owner
    const del = await fetch(`${base}/agents/allowedAgent/uploads/${created.upload_id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok-allowed' },
    });
    expect(del.status).toBe(200);
  });

  it('returns 404 on upload endpoints when uploads.enabled is false', async () => {
    store.updateConfig(UploadsConfig.parse({ enabled: false }));
    const addr = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${base}/agents/allowedAgent/uploads`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-allowed' },
      body: 'abc',
    });
    expect(res.status).toBe(404);
  });

  it('requires explicit allow on airlock/delete_upload for REST DELETE, encodes Unicode Content-Disposition, and disables direct routes when configured', async () => {
    const addr = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    // H5: prepare_upload allowed + delete_upload denied -> 403
    const createNoDel = await fetch(`${base}/agents/noDeleteAgent/uploads`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-nodelete', 'X-Filename': 'a.txt' },
      body: 'hi',
    });
    expect(createNoDel.status).toBe(201);
    const { upload_id: idNoDel } = (await createNoDel.json()) as { upload_id: string };
    const delDenied = await fetch(`${base}/agents/noDeleteAgent/uploads/${idNoDel}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok-nodelete' },
    });
    expect(delDenied.status).toBe(403);

    // H5: prepare_upload allowed + delete_upload ask -> 403
    const createAskDel = await fetch(`${base}/agents/askDeleteAgent/uploads`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-askdelete', 'X-Filename': 'b.txt' },
      body: 'hi',
    });
    expect(createAskDel.status).toBe(201);
    const { upload_id: idAskDel } = (await createAskDel.json()) as { upload_id: string };
    const delAsk = await fetch(`${base}/agents/askDeleteAgent/uploads/${idAskDel}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok-askdelete' },
    });
    expect(delAsk.status).toBe(403);

    // M5: Unicode + long surrogate-pair emoji filename truncates safely and downloads cleanly
    const emojiName = `${'😀'.repeat(200)}.pdf`;
    expect(() => encodeURIComponent(sanitizeFilename(emojiName))).not.toThrow();
    const uniPrep = store.prepareUpload('allowedAgent', { filename: `résumé-日本語-${emojiName}` });
    await store.completePresignedUpload(uniPrep.uploadToken, {
      stream: Readable.from([Buffer.from('%PDF')]),
    });
    const uniDl = store.mintDownloadUrl('allowedAgent', uniPrep.uploadId);
    const uniRes = await fetch(`${base}${uniDl.downloadPath}`);
    expect(uniRes.status).toBe(200);
    expect(uniRes.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(Buffer.from(await uniRes.arrayBuffer()).toString()).toBe('%PDF');

    // H5: direct routes fail closed without allowlist/getAgentConfig and enforce arg_policy on prepare_upload
    const badPluginApp = Fastify({ logger: false });
    await expect(badPluginApp.register(uploadsApiPlugin, { uploadStore: store })).rejects.toThrow(
      /requires allowlist and getAgentConfig/i
    );
    await badPluginApp.close();

    const policyAgent = makeAgentConfig({
      token: 'tok-policy',
      allow: ['airlock/prepare_upload'],
      arg_policy: {
        'airlock/prepare_upload': {
          filename: [{ glob_allow: ['*.3mf'] }],
        },
      },
    });
    const policyApp = Fastify({ logger: false });
    await policyApp.register(uploadsApiPlugin, {
      uploadStore: store,
      getAgentConfig: (id) => (id === 'policyAgent' ? policyAgent : undefined),
      allowlist: new AllowlistEngine({ policyAgent }),
      authRequired: true,
    });
    await policyApp.listen({ port: 0, host: '127.0.0.1' });
    try {
      const pPort = (policyApp.server.address() as { port: number }).port;
      const blockedExt = await fetch(`http://127.0.0.1:${pPort}/agents/policyAgent/uploads`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-policy', 'X-Filename': 'secret.txt' },
        body: 'nope',
      });
      expect(blockedExt.status).toBe(403);

      const allowedExt = await fetch(`http://127.0.0.1:${pPort}/agents/policyAgent/uploads`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-policy', 'X-Filename': 'part.3mf' },
        body: 'ok',
      });
      expect(allowedExt.status).toBe(201);
    } finally {
      await policyApp.close();
    }

    // H6: enableDirectRoutes: false exposes only presigned ticket routes (stdio mode)
    const stdioApp = Fastify({ logger: false });
    await stdioApp.register(uploadsApiPlugin, { uploadStore: store, enableDirectRoutes: false });
    await stdioApp.listen({ port: 0, host: '127.0.0.1' });
    try {
      const stdioPort = (stdioApp.server.address() as { port: number }).port;
      const blockedDirect = await fetch(
        `http://127.0.0.1:${stdioPort}/agents/allowedAgent/uploads`,
        {
          method: 'POST',
          body: 'nope',
        }
      );
      expect(blockedDirect.status).toBe(404);
    } finally {
      await stdioApp.close();
    }
  });
});

describe('Middleware + Adapters end-to-end (MCP, OpenAPI, HTTP, CLI, HITL, Audit)', () => {
  let workDir: string;
  let dbPath: string;
  let store: UploadStore;
  let auditLogger: AuditLogger;
  let hitlNotifications: HitlNotification[];
  let hitlEngine: HitlEngine;
  let hitlBatcher: HitlBatcher;

  beforeEach(async () => {
    lookupMock.mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as any);
    workDir = mkdtempSync(join(tmpdir(), 'airlock-upload-e2e-'));
    dbPath = join(workDir, 'audit.db');
    store = new UploadStore(
      makeUploadsConfig(join(workDir, 'staging'), {
        max_inline_bytes: 64,
        allowed_modes: ['base64', 'data_uri', 'text', 'url'],
      })
    );
    auditLogger = new AuditLogger({
      db_path: dbPath,
      retention_days: 7,
      redact_fields: ['token', 'secret'],
    });
    hitlNotifications = [];
    hitlEngine = new HitlEngine(auditLogger, makeNoopProvider(hitlNotifications), 5000);
    hitlBatcher = new HitlBatcher(0);
    hitlBatcher.onBatchReady((_agentId, reqs) => {
      for (const req of reqs) hitlNotifications.push(req);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    lookupMock.mockReset();
    auditLogger.stop();
    await store.stop();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function stageFile(agentId: string, filename: string, content: Buffer | string) {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    const prepared = store.prepareUpload(agentId, { filename });
    return store.completePresignedUpload(prepared.uploadToken, {
      stream: Readable.from([buf]),
    });
  }

  it('substitutes configured base64 + path_prefix into upstream MCP tools, auto-annotates schemas, enriches HITL, and keeps audit compact', async () => {
    const receivedCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mockPool = {
      isReady: () => true,
      getInstructions: () => undefined,
      listTools: async () => [
        {
          name: 'upload_attachment',
          description: 'Attach a file to an issue.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              issue_id: { type: 'number' },
              content_base64: { type: 'string', description: 'Base64 file content' },
            },
            required: ['issue_id', 'content_base64'],
          },
        },
        {
          name: 'import_3mf',
          description: 'Import a 3MF file from disk.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_path: { type: 'string' },
            },
            required: ['file_path'],
          },
        },
      ],
      callTool: async (_mcpId: string, tool: string, args: Record<string, unknown>) => {
        receivedCalls.push({ tool, args });
        return { content: [{ type: 'text', text: 'uploaded ok' }] };
      },
    } as unknown as ClientPool;

    const agent = makeAgentConfig({
      allow: ['airlock/prepare_upload', 'forge/import_3mf'],
      ask: ['forge/upload_attachment'],
      tool_overrides: {
        'forge/upload_attachment': {
          uploads: { content_base64: 'base64' },
        },
        'forge/import_3mf': {
          uploads: {
            file_path: { mode: 'path', path_prefix: '/shared/uploads' },
          },
        },
      },
    });
    const agents = { a1: agent };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry(
      [
        new McpBackendAdapter('forge', mockPool, undefined, store),
        new AirlockBackendAdapter({ uploadStore: store }),
      ],
      allowlist,
      agents
    );
    await registry.refresh();

    // Auto-annotation on tool description & schema property
    const visible = registry.getFiltered('a1');
    const attachTool = visible.find((t) => t.name === 'forge/upload_attachment');
    expect(attachTool?.description).toContain('airlock_prepare_upload');
    expect(
      (attachTool?.inputSchema.properties?.content_base64 as { description?: string })?.description
    ).toContain('airlock-upload://<id>');

    // 1. Path delivery with path_prefix works even though global allowed_modes excludes `path`
    const model = await stageFile('a1', 'bracket.3mf', '3MF-DATA');
    const chain = buildMiddlewareChain(agent);
    const pathCtx: ToolCallContext = {
      callId: 'c-path',
      agentId: 'a1',
      agentConfig: agent,
      toolName: 'forge/import_3mf',
      args: { file_path: model.ref },
      meta: {},
      deps: {
        registry,
        allowlist,
        hitlEngine,
        hitlBatcher,
        auditLogger,
        securityConfig: DEFAULT_SECURITY,
        uploadStore: store,
      },
      startedAt: Date.now(),
    };
    await chain(pathCtx, () => Promise.reject(new Error('missing execute')));
    expect(receivedCalls[0]).toEqual({
      tool: 'import_3mf',
      args: { file_path: `/shared/uploads/${model.upload_id}/bracket.3mf` },
    });

    // 2. Un-uploaded / invalid ref fails BEFORE HITL (zero notifications!)
    const pendingTicket = store.prepareUpload('a1', { filename: 'never-uploaded.png' });
    const badRes = await chain(
      {
        ...pathCtx,
        callId: 'c-bad',
        toolName: 'forge/upload_attachment',
        args: {
          issue_id: 7,
          content_base64: pendingTicket.ref,
          _airlock: { reason: 'Attach screenshot to issue 7' },
        },
        meta: {},
      },
      () => Promise.reject(new Error('missing execute'))
    );
    expect((badRes.result as { isError?: boolean }).isError).toBe(true);
    expect(badRes.text).toContain('has not finished uploading');
    expect(hitlNotifications).toHaveLength(0);

    // 3. Approval-gated MCP upload shows verified filename/size/sha256 in HITL and keeps audit compact
    const shot = await stageFile('a1', 'bug.png', Buffer.from('PNG-BYTES'));
    const callPromise = chain(
      {
        ...pathCtx,
        callId: 'c-hitl',
        toolName: 'forge/upload_attachment',
        args: {
          issue_id: 42,
          content_base64: shot.ref,
          _airlock: { reason: 'Attach bug screenshot to issue 42' },
        },
        meta: {},
      },
      () => Promise.reject(new Error('missing execute'))
    );

    await new Promise((r) => setTimeout(r, 20));
    const pending = hitlEngine.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].args.content_base64).toContain('bug.png');
    expect(pending[0].args.content_base64).toContain('image/png');
    expect(pending[0].args.content_base64).toContain(shot.sha256.slice(0, 12));

    hitlEngine.approve(pending[0].id);
    await callPromise;

    // Downstream MCP received real base64 bytes
    expect(receivedCalls[1]).toEqual({
      tool: 'upload_attachment',
      args: {
        issue_id: 42,
        content_base64: Buffer.from('PNG-BYTES').toString('base64'),
      },
    });

    // Audit row stayed compact and included verified upload metadata under _airlock.uploads
    const rows = auditLogger.query({ agent_id: 'a1', tool: 'forge/upload_attachment' });
    const successRow = rows.find((r) => r.result === 'success');
    expect(successRow).toBeDefined();
    expect(successRow!.args).not.toContain(Buffer.from('PNG-BYTES').toString('base64'));
    expect(successRow!.args).toContain(shot.ref);
    expect(successRow!.args).toContain(shot.sha256);
  });

  it('supports unconfigured MCP suffix modes (:base64, :data_uri, :text, :url), rejects disallowed :path and oversize inline', async () => {
    const received: Array<Record<string, unknown>> = [];
    const mockPool = {
      isReady: () => true,
      getInstructions: () => undefined,
      listTools: async () => [
        {
          name: 'generic_tool',
          description: 'Generic tool',
          inputSchema: {
            type: 'object' as const,
            properties: { data: { type: 'string' } },
            required: ['data'],
          },
        },
      ],
      callTool: async (_mcpId: string, _tool: string, args: Record<string, unknown>) => {
        received.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    } as unknown as ClientPool;

    const agent = makeAgentConfig({ allow: ['svc/*'] });
    const agents = { a1: agent };
    const allowlist = new AllowlistEngine(agents);
    const registry = new ToolRegistry(
      [new McpBackendAdapter('svc', mockPool, undefined, store)],
      allowlist,
      agents
    );
    await registry.refresh();
    const chain = buildMiddlewareChain(agent);

    const run = (data: string) =>
      chain(
        {
          callId: 'c1',
          agentId: 'a1',
          agentConfig: agent,
          toolName: 'svc/generic_tool',
          args: { data },
          meta: {},
          deps: {
            registry,
            allowlist,
            hitlEngine,
            hitlBatcher,
            auditLogger,
            securityConfig: DEFAULT_SECURITY,
            uploadStore: store,
          },
          startedAt: Date.now(),
        },
        () => Promise.reject(new Error('missing execute'))
      );

    const txt = await stageFile('a1', 'hello.txt', 'hello!');

    // Bare ref on unconfigured MCP tool gives actionable hint
    const bareRes = await run(txt.ref);
    expect((bareRes.result as { isError?: boolean }).isError).toBe(true);
    expect(bareRes.text).toContain('needs a delivery mode suffix');

    // :path is rejected because default allowed_modes omits path
    const pathRes = await run(`${txt.ref}:path`);
    expect((pathRes.result as { isError?: boolean }).isError).toBe(true);
    expect(pathRes.text).toContain('not allowed');

    // :data_uri, :text, :url succeed
    await run(`${txt.ref}:data_uri`);
    expect(received[0].data).toBe(
      `data:text/plain;base64,${Buffer.from('hello!').toString('base64')}`
    );

    await run(`${txt.ref}:text`);
    expect(received[1].data).toBe('hello!');

    await run(`${txt.ref}:url`);
    expect(String(received[2].data)).toMatch(/^https:\/\/airlock\.example\.com\/uploads\/dl\/dl_/);

    // Oversized inline (> 64 bytes configured above) rejected for :base64, allowed for :url
    const big = await stageFile('a1', 'big.bin', Buffer.alloc(100, 0x42));
    const bigInline = await run(`${big.ref}:base64`);
    expect((bigInline.result as { isError?: boolean }).isError).toBe(true);
    expect(bigInline.text).toContain('inline "base64" delivery limit');

    await run(`${big.ref}:url`);
    expect(String(received[3].data)).toMatch(/\/uploads\/dl\/dl_/);
  });

  it('sends OpenAPI multipart/form-data (FastAPI/Bambuddy 3.1 style), binary octet-stream, and JSON base64 uploads', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Bambuddy', version: '1.0.0' },
      servers: [{ url: 'https://bambuddy.example.com' }],
      paths: {
        '/api/v1/archives/upload': {
          post: {
            operationId: 'uploadArchive',
            summary: 'Upload a 3MF print archive',
            requestBody: {
              required: true,
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    properties: {
                      file: { type: 'string', format: 'binary', description: '3MF archive' },
                      thumbnail: {
                        anyOf: [{ type: 'string', format: 'binary' }, { type: 'null' }],
                        description: 'Optional preview image',
                      },
                      printer_id: { type: 'integer' },
                    },
                    required: ['file'],
                  },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/api/v1/releases/{id}/assets': {
          post: {
            operationId: 'uploadReleaseAsset',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'name', in: 'query', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: {
                'application/octet-stream': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
            responses: { '201': { description: 'Created' } },
          },
        },
        '/api/v1/repos/{repo}/contents/{path}': {
          put: {
            operationId: 'putRepoFile',
            parameters: [
              { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                      content: { type: 'string' },
                    },
                    required: ['message', 'content'],
                  },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const specPath = join(workDir, 'bambuddy.json');
    writeFileSync(specPath, JSON.stringify(spec));

    const adapter = new OpenApiAdapter(
      'bambuddy',
      {
        spec: specPath,
        auth: { type: 'bearer', token: 'bambu-secret' },
        timeout_ms: 10000,
        max_response_bytes: 1024 * 1024,
      },
      DEFAULT_SECURITY,
      store
    );
    const agent = makeAgentConfig({ allow: ['bambuddy/*'] });
    const allowlist = new AllowlistEngine({ a1: agent });
    const registry = new ToolRegistry([adapter], allowlist, { a1: agent });
    await registry.refresh();

    const tools = registry.getFiltered('a1');
    const uploadTool = tools.find((t) => t.name === 'bambuddy/uploadArchive');
    expect(
      (uploadTool?.inputSchema.properties?.file as { description?: string })?.description
    ).toContain('airlock-upload://<id>');

    const model = await stageFile('a1', 'benchy.3mf', Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const thumb = await stageFile('a1', 'benchy.png', Buffer.from('PNG'));

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 99 }), { status: 200 }));

    const chain = buildMiddlewareChain(agent);
    await chain(
      {
        callId: 'c-bambu',
        agentId: 'a1',
        agentConfig: agent,
        toolName: 'bambuddy/uploadArchive',
        args: { file: model.ref, thumbnail: thumb.ref, printer_id: 3 },
        meta: {},
        deps: {
          registry,
          allowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bambuddy.example.com/api/v1/archives/upload');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bambu-secret');
    expect((init.headers as Record<string, string>)['Content-Type']).toMatch(
      /^multipart\/form-data; boundary=/
    );
    expect(Number((init.headers as Record<string, string>)['Content-Length'])).toBeGreaterThan(0);
    expect(init.body).toBeInstanceOf(ReadableStream);
    const fd = await new Response(init.body, {
      headers: init.headers as Record<string, string>,
    }).formData();
    const sentFile = fd.get('file') as File;
    expect(sentFile.name).toBe('benchy.3mf');
    expect(sentFile.type).toBe('model/3mf');
    expect(Buffer.from(await sentFile.arrayBuffer())).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04])
    );
    expect((fd.get('thumbnail') as File).name).toBe('benchy.png');
    expect(fd.get('printer_id')).toBe('3');

    // Now test application/octet-stream raw binary endpoint
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    await chain(
      {
        callId: 'c-bin',
        agentId: 'a1',
        agentConfig: agent,
        toolName: 'bambuddy/uploadReleaseAsset',
        args: { id: 'rel-1', name: 'benchy.3mf', file: model.ref },
        meta: {},
        deps: {
          registry,
          allowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );
    const [binUrl, binInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(binUrl).toBe(
      'https://bambuddy.example.com/api/v1/releases/rel-1/assets?name=benchy.3mf'
    );
    expect((binInit.headers as Record<string, string>)['Content-Type']).toBe('model/3mf');
    expect((binInit.headers as Record<string, string>)['Content-Length']).toBe('4');
    expect(binInit.body).toBeInstanceOf(ReadableStream);
    expect(Buffer.from(await new Response(binInit.body).arrayBuffer())).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04])
    );

    // Now test application/json endpoint with :base64 upload ref substitution
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ committed: true }), { status: 200 }));
    await chain(
      {
        callId: 'c-json-b64',
        agentId: 'a1',
        agentConfig: agent,
        toolName: 'bambuddy/putRepoFile',
        args: {
          repo: 'prints',
          path: 'benchy.3mf',
          message: 'Add benchy',
          content: `${model.ref}:base64`,
        },
        meta: {},
        deps: {
          registry,
          allowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );
    const [jsonUrl, jsonInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(jsonUrl).toBe('https://bambuddy.example.com/api/v1/repos/prints/contents/benchy.3mf');
    expect(JSON.parse(jsonInit.body as string)).toEqual({
      message: 'Add benchy',
      content: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString('base64'),
    });
  });

  it('sends built-in http/post multipart and http/put body_upload while enforcing domain allowlists', async () => {
    const agent = makeAgentConfig({
      allow: ['http/*'],
      http: {
        domain_allowlist: ['uploads.example.com'],
        max_response_bytes: 1024,
        timeout_ms: 5000,
      },
    });
    const allowlist = new AllowlistEngine({ a1: agent });
    const registry = new ToolRegistry(
      [new HttpBackendAdapter({ a1: agent }, DEFAULT_SECURITY, store)],
      allowlist,
      { a1: agent }
    );
    await registry.refresh();
    const chain = buildMiddlewareChain(agent);

    const file = await stageFile('a1', 'image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    // Multipart upload via http/post
    await chain(
      {
        callId: 'c-http-mp',
        agentId: 'a1',
        agentConfig: agent,
        toolName: 'http/post',
        args: {
          url: 'https://uploads.example.com/attach',
          multipart: { file: file.ref, title: 'screenshot' },
        },
        meta: {},
        deps: {
          registry,
          allowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );
    const [, mpInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(mpInit.body).toBeInstanceOf(ReadableStream);
    const parsedMp = await new Response(mpInit.body, {
      headers: mpInit.headers as Record<string, string>,
    }).formData();
    expect((parsedMp.get('file') as File).name).toBe('image.png');
    expect(parsedMp.get('title')).toBe('screenshot');

    // Raw binary body via http/put body_upload
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(new Response('created', { status: 201 }));
    await chain(
      {
        callId: 'c-http-bin',
        agentId: 'a1',
        agentConfig: agent,
        toolName: 'http/put',
        args: {
          url: 'https://uploads.example.com/raw/image.png',
          body_upload: file.ref,
        },
        meta: {},
        deps: {
          registry,
          allowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );
    const [, rawInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((rawInit.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect((rawInit.headers as Record<string, string>)['Content-Length']).toBe('4');
    expect(rawInit.body).toBeInstanceOf(ReadableStream);
    expect(Buffer.from(await new Response(rawInit.body).arrayBuffer())).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );

    // Upload ref in URL is rejected by uploadPolicyMiddleware
    const badUrl = await chain(
      {
        callId: 'c-http-bad',
        agentId: 'a1',
        agentConfig: agent,
        toolName: 'http/get',
        args: { url: file.ref },
        meta: {},
        deps: {
          registry,
          allowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );
    expect((badUrl.result as { isError?: boolean }).isError).toBe(true);
    expect(badUrl.text).toContain('only accept staged uploads in "body_upload" or "multipart"');
  });

  it('delivers staged disk path to CLI backend tools when configured in tool_overrides', async () => {
    const cliAdapter = new CliBackendAdapter(
      'inspect',
      {
        max_output_bytes: 10000,
        commands: {
          cat_file: {
            exec: 'cat {file}',
            params: {
              file: { type: 'string', positional: false, required: true },
            },
            timeout: 10,
          },
        },
      },
      undefined,
      store
    );
    const agent = makeAgentConfig({
      allow: ['inspect/*'],
      tool_overrides: {
        'inspect/cat_file': {
          uploads: { file: 'path' },
        },
      },
    });
    const allowlist = new AllowlistEngine({ a1: agent });
    const registry = new ToolRegistry([cliAdapter], allowlist, { a1: agent });
    await registry.refresh();

    const staged = await stageFile('a1', 'hello world.txt', 'staged cli payload');
    const chain = buildMiddlewareChain(agent);
    const response = await chain(
      {
        callId: 'c-cli',
        agentId: 'a1',
        agentConfig: agent,
        toolName: 'inspect/cat_file',
        args: { file: staged.ref },
        meta: {},
        deps: {
          registry,
          allowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );

    expect((response.result as { stdout: string }).stdout).toBe('staged cli payload');
  });

  it('enforces upload validation in request_approval plans, blocks command_policy/arg_policy substitution, runs Ajv on effective args, blocks plan bypass on detector escalation, and handles mixed OpenAPI uploads', async () => {
    const received: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mockPool = {
      isReady: () => true,
      getInstructions: () => undefined,
      listTools: async () => [
        {
          name: 'run_cmd',
          description: 'Run a tool command',
          inputSchema: {
            type: 'object' as const,
            properties: {
              cmd: { type: 'string' },
              note: { type: 'string', maxLength: 50 },
              level: { type: 'string', enum: ['low', 'high'] },
            },
            required: ['cmd'],
          },
        },
        {
          name: 'upload_note',
          description: 'Upload text note',
          inputSchema: {
            type: 'object' as const,
            properties: {
              repo: { type: 'string' },
              body: { type: 'string' },
              parts: { type: 'array', items: { type: 'string' } },
              recipients: {
                type: 'array',
                items: { type: 'object', properties: { email: { type: 'string' } } },
              },
              nested: { type: 'object', properties: { data: { type: 'string' } } },
              'nested.data': { type: 'string' },
            },
          },
        },
      ],
      callTool: async (_mcpId: string, tool: string, args: Record<string, unknown>) => {
        received.push({ tool, args });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    } as unknown as ClientPool;

    const agent = makeAgentConfig({
      allow: ['svc/run_cmd', 'svc/upload_note'],
      ask: ['svc/upload_note'],
      command_policy: {
        'svc/run_cmd': {
          cmd: { default: 'allow', deny: ['rm *'], allow: [], ask: [] },
        },
      },
      arg_policy: {
        'svc/upload_note': {
          repo: [{ glob_allow: ['*'] }],
          recipient_emails: [{ path: 'recipients.email', glob_allow: ['*'], required: false }],
        },
      },
      tool_overrides: {
        'svc/upload_note': {
          uploads: {
            'nested.data': 'base64',
          },
        },
      },
      middleware: [{ name: 'sensitivity-classifier', mode: 'escalate', threshold: 0.7 }],
    });
    const agents = { a1: agent };
    const allowlist = new AllowlistEngine(agents);
    let registry!: ToolRegistry;
    const airlockAdapter = new AirlockBackendAdapter({
      hitlEngine,
      hitlBatcher,
      uploadStore: store,
      getAgentTools: (id) => registry.getFilteredWithDecisions(id),
      getAgentConfig: (id) => agents[id as keyof typeof agents],
      getToolBackendKind: (tool, id) => registry.getToolBackendKind(tool, id),
      nativeUploadArgKind: (tool, topKey, id) => registry.nativeUploadArgKind(tool, topKey, id),
    });
    registry = new ToolRegistry(
      [new McpBackendAdapter('svc', mockPool, undefined, store), airlockAdapter],
      allowlist,
      agents
    );
    await registry.refresh();
    const chain = buildMiddlewareChain(agent);

    const runCall = (toolName: string, args: Record<string, unknown>) =>
      chain(
        {
          callId: `c-${toolName}`,
          agentId: 'a1',
          agentConfig: agent,
          toolName,
          args,
          meta: {},
          deps: {
            registry,
            allowlist,
            hitlEngine,
            hitlBatcher,
            auditLogger,
            securityConfig: DEFAULT_SECURITY,
            uploadStore: store,
          },
          startedAt: Date.now(),
        },
        () => Promise.reject(new Error('missing execute'))
      );

    // C1: request_approval rejects pending refs on BOTH ask tools AND allow tools in a mixed plan
    const pending = store.prepareUpload('a1', { filename: 'pending.txt' });
    const badPlan = await airlockAdapter.call({
      tool: 'airlock/request_approval',
      agentId: 'a1',
      args: {
        reason: 'Plan with pending upload',
        calls: [
          { tool: 'svc/upload_note', arguments: { repo: 'myrepo', body: `${pending.ref}:text` } },
        ],
      },
    });
    expect(badPlan.success).toBe(false);
    expect(badPlan.error).toContain('has not finished uploading');

    const ready = await stageFile('a1', 'hello.txt', 'hello world');
    const badMixedPlan = await airlockAdapter.call({
      tool: 'airlock/request_approval',
      agentId: 'a1',
      args: {
        reason: 'Mixed plan with invalid allow call upload',
        calls: [
          { tool: 'svc/run_cmd', arguments: { cmd: 'echo hi', note: `${pending.ref}:text` } },
          { tool: 'svc/upload_note', arguments: { repo: 'myrepo', body: `${ready.ref}:text` } },
        ],
      },
    });
    expect(badMixedPlan.success).toBe(false);
    expect(badMixedPlan.error).toContain('has not finished uploading');

    const waitForPending = async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const pendingTickets = hitlEngine.getPending();
        if (pendingTickets.length > 0) return pendingTickets;
        await new Promise((r) => setTimeout(r, 5));
      }
      return hitlEngine.getPending();
    };

    // C1: request_approval accepts ready upload, binds grant to validated digest+mode, and replays cleanly
    const planPromise = airlockAdapter.call({
      tool: 'airlock/request_approval',
      agentId: 'a1',
      args: {
        reason: 'Plan with ready upload',
        calls: [
          { tool: 'svc/upload_note', arguments: { repo: 'myrepo', body: `${ready.ref}:text` } },
        ],
      },
    });
    const tickets = await waitForPending();
    expect(tickets).toHaveLength(1);
    hitlEngine.approve(tickets[0].id);
    const planRes = await planPromise;
    expect(planRes.success).toBe(true);

    const execRes = await runCall('svc/upload_note', {
      repo: 'myrepo',
      body: `${ready.ref}:text`,
      _airlock: { reason: 'Execute planned upload' },
    });
    expect((execRes.result as { isError?: boolean }).isError).toBeUndefined();
    expect(received[0]).toEqual({
      tool: 'upload_note',
      args: { repo: 'myrepo', body: 'hello world' },
    });

    // C1/C2: a pre-approved plan grant CANNOT conceal a detector escalation on sensitive :text content
    const fakeAwsKey = `AKIA${'IOSFODNN7'}EXAMPLE`;
    const secretFile = await stageFile('a1', 'creds.txt', `aws=${fakeAwsKey}`);
    const sensPlanPromise = airlockAdapter.call({
      tool: 'airlock/request_approval',
      agentId: 'a1',
      args: {
        reason: 'Plan with secret file',
        calls: [
          {
            tool: 'svc/upload_note',
            arguments: { repo: 'myrepo', body: `${secretFile.ref}:text` },
          },
        ],
      },
    });
    const sensPlanTickets = await waitForPending();
    expect(sensPlanTickets).toHaveLength(1);
    hitlEngine.approve(sensPlanTickets[0].id);
    expect((await sensPlanPromise).success).toBe(true);

    // Executing that planned call triggers sensitivity-classifier escalation -> requires fresh approval
    // and carries the sanitized detector reason into the operator notification!
    const sensExecPromise = runCall('svc/upload_note', {
      repo: 'myrepo',
      body: `${secretFile.ref}:text`,
      _airlock: { reason: 'Execute secret plan' },
    });
    const freshTickets = await waitForPending();
    expect(freshTickets).toHaveLength(1);
    expect(freshTickets[0].escalationReason).toMatch(
      /High sensitivity data detected.*aws_access_key/i
    );
    const freshNotif = hitlEngine.buildNotification(freshTickets[0].id);
    expect(freshNotif?.escalated).toBe(true);
    expect(freshNotif?.escalationReason).toMatch(/High sensitivity data detected.*aws_access_key/i);
    expect(formatNotification(freshNotif!)).toContain('High sensitivity data detected');
    hitlEngine.deny(freshTickets[0].id);
    const sensExecRes = await sensExecPromise;
    expect((sensExecRes.result as { isError?: boolean }).isError).toBe(true);

    // C2: command_policy rejects upload ref even when default: allow
    const cmdFile = await stageFile('a1', 'cmd.txt', 'rm -rf /');
    const cmdBlocked = await runCall('svc/run_cmd', { cmd: `${cmdFile.ref}:text` });
    expect((cmdBlocked.result as { isError?: boolean }).isError).toBe(true);
    expect(cmdBlocked.text).toContain('command_policy');

    // C2: arg_policy rejects upload ref on both top-level and array-unwrapped nested dotted paths
    const argBlocked = await runCall('svc/upload_note', {
      repo: `${ready.ref}:text`,
      body: 'ok',
      _airlock: { reason: 'Test arg policy rejection' },
    });
    expect((argBlocked.result as { isError?: boolean }).isError).toBe(true);
    expect(argBlocked.text).toContain('arg_policy');

    const nestedArrayBlocked = await runCall('svc/upload_note', {
      repo: 'myrepo',
      recipients: [{ email: `${ready.ref}:text` }],
      _airlock: { reason: 'Test implicit array arg_policy overlap' },
    });
    expect((nestedArrayBlocked.result as { isError?: boolean }).isError).toBe(true);
    expect(nestedArrayBlocked.text).toContain('arg_policy');

    // C2: literal dotted key `"nested.data"` cannot steal mapping configured for nested `nested.data`
    const literalDotKeyRes = await runCall('svc/upload_note', {
      repo: 'myrepo',
      'nested.data': ready.ref,
      _airlock: { reason: 'Test literal dotted key isolation' },
    });
    expect((literalDotKeyRes.result as { isError?: boolean }).isError).toBe(true);
    expect(literalDotKeyRes.text).toContain('needs a delivery mode suffix');

    // C2: Ajv validates effective args (valid enum `:text` succeeds; oversize `:text` throws InvalidParams)
    const validEnum = await stageFile('a1', 'level.txt', 'high');
    const enumOk = await runCall('svc/run_cmd', { cmd: 'echo hi', level: `${validEnum.ref}:text` });
    expect((enumOk.result as { isError?: boolean }).isError).toBeUndefined();
    expect(received[1]).toEqual({
      tool: 'run_cmd',
      args: { cmd: 'echo hi', level: 'high' },
    });

    const longNote = await stageFile('a1', 'long.txt', 'x'.repeat(60));
    await expect(
      runCall('svc/run_cmd', { cmd: 'echo hi', note: `${longNote.ref}:text` })
    ).rejects.toThrow(/Invalid arguments:.*max|50/i);

    // H3: repeated inline refs exceeding per-call aggregate materialization cap are rejected
    const chunk = await stageFile('a1', 'chunk.bin', Buffer.alloc(40, 0x61));
    const ampRes = await runCall('svc/upload_note', {
      repo: 'myrepo',
      parts: [
        `${chunk.ref}:base64`,
        `${chunk.ref}:base64`,
        `${chunk.ref}:base64`,
        `${chunk.ref}:base64`,
      ],
      _airlock: { reason: 'Test aggregate inline cap' },
    });
    expect((ampRes.result as { isError?: boolean }).isError).toBe(true);
    expect(ampRes.text).toContain('Combined inline upload substitution size');

    // M3 + M6: OpenAPI handles mixed native file + :text query/multipart, nullable binary, AND OpenAPI 3.1 type:['array','null']
    const specPath = join(workDir, 'nullable-spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Test', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/upload': {
            post: {
              operationId: 'sendDoc',
              parameters: [{ name: 'tag', in: 'query', schema: { type: 'string' } }],
              requestBody: {
                required: true,
                content: {
                  'multipart/form-data': {
                    schema: {
                      type: 'object',
                      properties: {
                        file: { anyOf: [{ type: 'string', format: 'binary' }, { type: 'null' }] },
                        extras: {
                          type: ['array', 'null'],
                          items: { type: 'string', format: 'binary' },
                        },
                        caption: { type: 'string' },
                      },
                      required: ['file'],
                    },
                  },
                },
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      })
    );
    const apiAdapter = new OpenApiAdapter(
      'docapi',
      { spec: specPath, timeout_ms: 5000, max_response_bytes: 1024 },
      DEFAULT_SECURITY,
      store
    );
    const apiAgent = makeAgentConfig({ allow: ['docapi/*'] });
    const apiAllowlist = new AllowlistEngine({ a1: apiAgent });
    const apiRegistry = new ToolRegistry([apiAdapter], apiAllowlist, { a1: apiAgent });
    await apiRegistry.refresh();
    const apiChain = buildMiddlewareChain(apiAgent);

    const tagFile = await stageFile('a1', 'tag.txt', 'v2-release');
    const capFile = await stageFile('a1', 'cap.txt', 'Release notes');
    const binFile = await stageFile('a1', 'part.3mf', Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    // 1. Nullable file: null + extras: null with :text query & caption
    await apiChain(
      {
        callId: 'c-openapi-null',
        agentId: 'a1',
        agentConfig: apiAgent,
        toolName: 'docapi/sendDoc',
        args: {
          file: null,
          extras: null,
          tag: `${tagFile.ref}:text`,
          caption: `${capFile.ref}:text`,
        },
        meta: {},
        deps: {
          registry: apiRegistry,
          allowlist: apiAllowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [apiUrl, apiInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(apiUrl).toBe('https://api.example.com/upload?tag=v2-release');
    const apiForm = await new Response(apiInit.body, {
      headers: apiInit.headers as Record<string, string>,
    }).formData();
    expect(apiForm.get('file')).toBeNull();
    expect(apiForm.get('caption')).toBe('Release notes');

    // 2. M3: Mixed native binary file + type:['array','null'] binary array + :text query & caption!
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
    await apiChain(
      {
        callId: 'c-openapi-mixed',
        agentId: 'a1',
        agentConfig: apiAgent,
        toolName: 'docapi/sendDoc',
        args: {
          file: binFile.ref,
          extras: [binFile.ref],
          tag: `${tagFile.ref}:text`,
          caption: `${capFile.ref}:text`,
        },
        meta: {},
        deps: {
          registry: apiRegistry,
          allowlist: apiAllowlist,
          hitlEngine,
          hitlBatcher,
          auditLogger,
          securityConfig: DEFAULT_SECURITY,
          uploadStore: store,
        },
        startedAt: Date.now(),
      },
      () => Promise.reject(new Error('missing execute'))
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [mixUrl, mixInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(mixUrl).toBe('https://api.example.com/upload?tag=v2-release');
    const mixForm = await new Response(mixInit.body, {
      headers: mixInit.headers as Record<string, string>,
    }).formData();
    expect((mixForm.get('file') as File).name).toBe('part.3mf');
    expect((mixForm.get('extras') as File).name).toBe('part.3mf');
    expect(mixForm.get('caption')).toBe('Release notes');
  });
});

describe('Gateway full round-trip: prepare_upload -> PUT bytes -> OpenAPI Bambuddy multipart upload', () => {
  let workDir: string;
  let upstreamApp: ReturnType<typeof Fastify>;
  let gateway: Gateway;

  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    workDir = mkdtempSync(join(tmpdir(), 'airlock-upload-gw-'));
  });

  afterEach(async () => {
    await gateway?.stop();
    await upstreamApp?.close();
    lookupMock.mockReset();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('uploads a binary .3mf file end-to-end through Gateway data-plane', async () => {
    let capturedAuth = '';
    let capturedFilename = '';
    let capturedMime = '';
    let capturedPrinterId = '';
    let capturedBytes = Buffer.alloc(0);

    upstreamApp = Fastify({ logger: false });
    upstreamApp.removeAllContentTypeParsers();
    upstreamApp.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    upstreamApp.post('/api/v1/archives/upload', async (req, reply) => {
      capturedAuth = String(req.headers.authorization ?? '');
      const chunks: Buffer[] = [];
      for await (const chunk of req.raw) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const response = new Response(new Uint8Array(Buffer.concat(chunks)), {
        headers: { 'content-type': String(req.headers['content-type'] ?? '') },
      });
      const form = await response.formData();
      const file = form.get('file') as File;
      capturedFilename = file.name;
      capturedMime = file.type;
      capturedBytes = Buffer.from(await file.arrayBuffer());
      capturedPrinterId = String(form.get('printer_id') ?? '');
      return reply.status(201).send({ archive_id: 'arc_42', filename: file.name });
    });
    await upstreamApp.listen({ port: 0, host: '127.0.0.1' });
    const upstreamPort = (upstreamApp.server.address() as { port: number }).port;

    const specPath = join(workDir, 'bambuddy-spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Bambuddy', version: '1.0.0' },
        servers: [{ url: `http://127.0.0.1:${upstreamPort}` }],
        paths: {
          '/api/v1/archives/upload': {
            post: {
              operationId: 'upload_archive',
              requestBody: {
                required: true,
                content: {
                  'multipart/form-data': {
                    schema: {
                      type: 'object',
                      properties: {
                        file: { type: 'string', format: 'binary' },
                        printer_id: { type: 'integer' },
                      },
                      required: ['file'],
                    },
                  },
                },
              },
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      })
    );

    const config = GatewayConfig.parse({
      apis: {
        bambuddy: {
          spec: specPath,
          auth: { type: 'bearer', token: 'bambuddy-live-token' },
        },
      },
      uploads: {
        enabled: true,
        dir: join(workDir, 'uploads'),
      },
      security: {
        allowed_local: ['127.0.0.1'],
      },
      audit: {
        db_path: join(workDir, 'audit.db'),
      },
      server: {
        host: '127.0.0.1',
        port: 1,
        expose_tools_api: 'all',
      },
      agents: {
        builder: {
          token: 'agent-secret',
          allow: ['airlock/prepare_upload', 'bambuddy/*'],
        },
      },
    });
    config.server.port = 0;

    gateway = new Gateway(config);
    await gateway.start();

    const gwBase = (
      gateway as unknown as { uploadStore: UploadStore }
    ).uploadStore.getPublicBaseUrl();

    // 1. Agent calls airlock/prepare_upload
    const prepRes = await fetch(`${gwBase}/agents/builder/tools/invoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer agent-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'airlock/prepare_upload',
        args: { filename: 'extruder-mount.3mf' },
      }),
    });
    expect(prepRes.status).toBe(200);
    const prepJson = (await prepRes.json()) as {
      success: boolean;
      data: { upload_id: string; ref: string; upload_url: string };
    };
    expect(prepJson.success).toBe(true);

    // 2. Agent uploads bytes from disk via curl-equivalent PUT (no agent bearer token needed!)
    const filePayload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x99]);
    const putRes = await fetch(prepJson.data.upload_url, {
      method: 'PUT',
      body: filePayload,
    });
    expect(putRes.status).toBe(201);

    // 3. Agent calls bambuddy/upload_archive with the staged ref
    const callRes = await fetch(`${gwBase}/agents/builder/tools/invoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer agent-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'bambuddy/upload_archive',
        args: { file: prepJson.data.ref, printer_id: 2 },
      }),
    });
    expect(callRes.status).toBe(200);
    const callJson = (await callRes.json()) as {
      success: boolean;
      data: { status: number; body: string };
    };
    expect(callJson.success).toBe(true);
    expect(callJson.data.status).toBe(201);
    expect(JSON.parse(callJson.data.body)).toEqual({
      archive_id: 'arc_42',
      filename: 'extruder-mount.3mf',
    });

    // Upstream Bambuddy received the exact binary file, filename, MIME type, field, and Airlock-injected auth
    expect(capturedAuth).toBe('Bearer bambuddy-live-token');
    expect(capturedFilename).toBe('extruder-mount.3mf');
    expect(capturedMime).toBe('model/3mf');
    expect(capturedPrinterId).toBe('2');
    expect(capturedBytes.equals(filePayload)).toBe(true);
  });

  it('selects matching hostname from uploads.public_urls via X-Forwarded-Host and disables fixed requestTimeout', async () => {
    const config = GatewayConfig.parse({
      uploads: {
        enabled: true,
        dir: join(workDir, 'uploads-multi'),
        public_urls: ['https://airlock-mcp.chrls.dev', 'https://airlock-mcp.merino-snares.ts.net'],
      },
      audit: {
        db_path: join(workDir, 'audit-multi.db'),
      },
      server: {
        host: '127.0.0.1',
        port: 1,
        expose_tools_api: 'all',
      },
      agents: {
        charon: {
          token: 'charon-secret',
          allow: ['airlock/prepare_upload', 'airlock/delete_upload'],
        },
      },
    });
    config.server.port = 0;

    gateway = new Gateway(config);
    await gateway.start();

    const app = (gateway as unknown as { app: ReturnType<typeof Fastify> }).app;
    expect(app.server.requestTimeout).toBe(0);
    const port = (app.server.address() as { port: number }).port;

    const tsRes = await fetch(`http://127.0.0.1:${port}/agents/charon/tools/invoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer charon-secret',
        'Content-Type': 'application/json',
        'X-Forwarded-Host': 'airlock-mcp.merino-snares.ts.net',
      },
      body: JSON.stringify({
        tool: 'airlock/prepare_upload',
        args: { filename: 'part.3mf' },
      }),
    });
    const tsJson = (await tsRes.json()) as { success: boolean; data: { upload_url: string } };
    expect(tsJson.success).toBe(true);
    expect(tsJson.data.upload_url).toMatch(
      /^https:\/\/airlock-mcp\.merino-snares\.ts\.net\/uploads\/up_/
    );

    const spoofRes = await fetch(`http://127.0.0.1:${port}/agents/charon/tools/invoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer charon-secret',
        'Content-Type': 'application/json',
        'X-Forwarded-Host': 'evil.example.com',
      },
      body: JSON.stringify({
        tool: 'airlock/prepare_upload',
        args: { filename: 'part.3mf' },
      }),
    });
    const spoofJson = (await spoofRes.json()) as { success: boolean; data: { upload_url: string } };
    expect(spoofJson.success).toBe(true);
    expect(spoofJson.data.upload_url).toMatch(/^https:\/\/airlock-mcp\.chrls\.dev\/uploads\/up_/);

    // Two sessions sharing the same agent profile cannot delete each other's uploads via direct HTTP
    const directA = await fetch(`http://127.0.0.1:${port}/agents/charon/uploads`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer charon-secret',
        'X-Airlock-Session-Id': 'thread-a',
        'X-Filename': 'a.txt',
      },
      body: 'from-a',
    });
    expect(directA.status).toBe(201);
    const { upload_id: idA } = (await directA.json()) as { upload_id: string };

    const crossDel = await fetch(`http://127.0.0.1:${port}/agents/charon/uploads/${idA}`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer charon-secret',
        'X-Airlock-Session-Id': 'thread-b',
      },
    });
    expect(crossDel.status).toBe(404);

    const ownDel = await fetch(`http://127.0.0.1:${port}/agents/charon/uploads/${idA}`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer charon-secret',
        'X-Airlock-Session-Id': 'thread-a',
      },
    });
    expect(ownDel.status).toBe(200);
  });
});

describe('Config schema, profiles, and loader diagnostics for uploads', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'airlock-upload-cfg-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('rejects path_prefix when mode is not path', () => {
    expect(() =>
      GatewayConfig.parse({
        agents: {
          a1: {
            tool_overrides: {
              'forge/upload': {
                uploads: {
                  content: { mode: 'base64', path_prefix: '/shared' },
                },
              },
            },
          },
        },
      })
    ).toThrow(/path_prefix/);
  });

  it('composes tool_overrides.uploads across profile extends', () => {
    const config = GatewayConfig.parse({
      profiles: {
        forge_base: {
          allow: ['forge/*'],
          tool_overrides: {
            'forge/upload': {
              uploads: { content_base64: 'base64' },
            },
          },
        },
      },
      agents: {
        a1: {
          extends: ['forge_base'],
          tool_overrides: {
            'forge/upload': {
              uploads: { thumbnail: 'data_uri' },
            },
          },
        },
      },
    });
    applyProfiles(config);
    expect(config.agents.a1.tool_overrides['forge/upload'].uploads).toEqual({
      content_base64: { mode: 'base64' },
      thumbnail: { mode: 'data_uri' },
    });
  });

  it('accepts airlock/prepare_upload and apis namespaces when uploads.enabled is true, and warns when false', () => {
    const enabledPath = join(workDir, 'enabled.yaml');
    writeFileSync(
      enabledPath,
      [
        'uploads:',
        '  enabled: true',
        'apis:',
        '  bambuddy:',
        '    spec: ./bambuddy.json',
        'agents:',
        '  builder:',
        '    allow:',
        '      - airlock/prepare_upload',
        '      - bambuddy/*',
      ].join('\n')
    );
    const ok = loadConfigDetailed(enabledPath, { resolveEnv: false });
    expect(ok.diagnostics.filter((d) => d.level === 'error')).toEqual([]);

    const disabledPath = join(workDir, 'disabled.yaml');
    writeFileSync(
      disabledPath,
      [
        'providers:',
        '  airlock: builtin',
        'agents:',
        '  builder:',
        '    allow:',
        '      - airlock/prepare_upload',
      ].join('\n')
    );
    const warned = loadConfigDetailed(disabledPath, { resolveEnv: false });
    expect(warned.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('uploads.enabled is false'),
        }),
      ])
    );

    const oversizedPath = join(workDir, 'oversized.yaml');
    writeFileSync(
      oversizedPath,
      [
        'uploads:',
        '  enabled: true',
        '  max_file_bytes: 52428800',
        '  max_total_bytes: 104857600',
        'agents:',
        '  autovideo:',
        '    allow:',
        '      - airlock/prepare_upload',
        '    uploads:',
        '      max_file_bytes: 1073741824',
      ].join('\n')
    );
    const oversized = loadConfigDetailed(oversizedPath, { resolveEnv: false });
    expect(oversized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          agent: 'autovideo',
          message: expect.stringContaining('exceeds uploads.max_total_bytes'),
        }),
      ])
    );
  });

  it('authenticates streaming chunks before release, isolates pointer rules & __proto__, validates exact :url args, aborts active downloads on disable, and defers unknown multipart policies', async () => {
    // 1. Explicit JSON Pointer rule "/files" must NOT authorize literal slash-prefixed array ["/files", 0]
    expect(matchToolUploadRule({ '/files': 'base64' }, ['/files', 0])).toBeUndefined();
    expect(matchToolUploadRule({ '/files': 'base64' }, ['files'])).toBe('base64');
    expect(matchToolUploadRule({ files: 'base64' }, ['files', 0])).toBe('base64');

    // 2. annotateUploadArgs & replaceUploadRefs preserve own "__proto__" data properties cleanly
    const protoArgs = JSON.parse(
      '{"__proto__":{"nested":"airlock-upload://upl_0123456789abcdefghijkl:text"},"ok":"yes"}'
    ) as Record<string, unknown>;
    const annotated = annotateUploadArgs(protoArgs, () => 'desc');
    expect(Object.getPrototypeOf(annotated)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(annotated, '__proto__')).toBe(true);
    expect(JSON.stringify(annotated)).toContain('"__proto__"');
    expect(JSON.stringify(annotated)).toContain('(desc)');

    const replaced = await replaceUploadRefs(protoArgs, async () => 'replaced-val');
    expect(Object.getPrototypeOf(replaced)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(replaced, '__proto__')).toBe(true);
    expect(JSON.stringify(replaced)).toBe('{"__proto__":{"nested":"replaced-val"},"ok":"yes"}');

    // 3. Chunk-authenticated streaming: in-place tampering after open emits ZERO corrupted bytes
    const storeDir = mkdtempSync(join(workDir, 'stream-auth-'));
    const store = new UploadStore(makeUploadsConfig(storeDir, { max_file_bytes: 4 * 1024 * 1024 }));
    try {
      const prep = store.prepareUpload('a', { filename: 'multi-blocks.bin' });
      // 4 full 256 KiB blocks + 1 KiB tail so backpressure pauses before the tail block is read.
      const prefixBytes = 4 * 256 * 1024;
      const original = Buffer.concat([Buffer.alloc(prefixBytes, 0x41), Buffer.alloc(1024, 0x42)]);
      await store.completePresignedUpload(prep.uploadToken, {
        stream: Readable.from([original]),
      });
      const rec = store.getReadyUpload('a', prep.uploadId)!;
      const { downloadToken } = store.mintDownloadUrl('a', prep.uploadId);
      const opened = await store.openDownload(downloadToken, true);
      expect(opened?.stream).toBeDefined();
      // Let initial backpressured read settle, then corrupt the unread tail block in place
      await new Promise((r) => setTimeout(r, 20));
      const { open: openFs } = await import('fs/promises');
      const writer = await openFs(rec.diskPath, 'r+');
      try {
        await writer.write(Buffer.from('CORRUPT!'), 0, 8, prefixBytes);
      } finally {
        await writer.close();
      }
      const receivedChunks: Buffer[] = [];
      await expect(
        (async () => {
          for await (const chunk of opened!.stream!) {
            receivedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
        })()
      ).rejects.toThrow(/SHA-256 integrity verification/i);
      const emitted = Buffer.concat(receivedChunks);
      // Only authentic pre-tamper blocks were emitted; ZERO bytes of the corrupted block escaped!
      expect(emitted.byteLength).toBe(prefixBytes);
      expect(emitted.includes(Buffer.from('CORRUPT!'))).toBe(false);

      // 4. Disabling uploads immediately aborts active GET streams & preserves quota accounting
      const small = store.prepareUpload('a', { filename: 'active-dl.bin' });
      await store.completePresignedUpload(small.uploadToken, {
        stream: Readable.from([Buffer.alloc(64, 0x55)]),
      });
      const { downloadToken: dl2 } = store.mintDownloadUrl('a', small.uploadId);
      const activeDl = await store.openDownload(dl2, true);
      expect(activeDl?.stream).toBeDefined();
      const abortErr = new Promise<Error>((resolve) => {
        activeDl!.stream!.once('error', (err) => resolve(err));
      });
      store.updateConfig(UploadsConfig.parse({ enabled: false }));
      expect((await abortErr).message).toMatch(/disabled/i);
    } finally {
      await store.stop();
    }

    // 5. Exact :url dispatch validation rejects token-sensitive mismatch and revokes minted ticket
    const urlDir = mkdtempSync(join(workDir, 'url-schema-'));
    const urlStore = new UploadStore(makeUploadsConfig(urlDir), 'http://127.0.0.1:4111');
    const auditLogger = new AuditLogger(
      { db_path: join(workDir, 'url-audit.db'), log_level: 'error', redact_secrets: true },
      'error'
    );
    const hitlProvider: HitlProvider = {
      init: async () => {},
      notify: async () => {},
      stop: async () => {},
    };
    const hitlEngine = new HitlEngine(auditLogger, hitlProvider, 5000);
    const hitlBatcher = new HitlBatcher(1);
    const dispatchedCalls: unknown[] = [];
    const mockPool = {
      isReady: () => true,
      listTools: async () => [
        {
          name: 'fetch_url',
          description: 'Accept only synthetic zero token URL',
          inputSchema: {
            type: 'object' as const,
            properties: {
              url: {
                type: 'string',
                // Matches the pre-HITL canonical 32-byte placeholder #1 (dl_AAA...AAE), fails on real random token
                pattern:
                  '^https://airlock\\.example\\.com/uploads/dl/dl_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE$',
              },
            },
            required: ['url'],
          },
        },
      ],
      callTool: async (_mcpId: string, _tool: string, args: Record<string, unknown>) => {
        dispatchedCalls.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    } as unknown as ClientPool;
    const urlAgent = makeAgentConfig({
      allow: ['svc/fetch_url'],
      uploads: { allowed_modes: ['url'] },
    });
    const urlAgents = { a1: urlAgent };
    const urlAllowlist = new AllowlistEngine(urlAgents);
    const urlRegistry = new ToolRegistry(
      [new McpBackendAdapter('svc', mockPool, undefined, urlStore)],
      urlAllowlist,
      urlAgents
    );
    await urlRegistry.refresh();
    const urlChain = buildMiddlewareChain(urlAgent);
    try {
      const staged = urlStore.prepareUpload('a1', { filename: 'doc.txt' });
      await urlStore.completePresignedUpload(staged.uploadToken, {
        stream: Readable.from([Buffer.from('hello')]),
      });
      const mintSpy = vi.spyOn(urlStore, 'mintDownloadUrl');
      await expect(
        urlChain(
          {
            callId: 'c-url-1',
            agentId: 'a1',
            agentConfig: urlAgent,
            toolName: 'svc/fetch_url',
            args: { url: `${staged.ref}:url` },
            meta: {},
            deps: {
              registry: urlRegistry,
              allowlist: urlAllowlist,
              hitlEngine,
              hitlBatcher,
              auditLogger,
              securityConfig: DEFAULT_SECURITY,
              uploadStore: urlStore,
            },
            startedAt: Date.now(),
          },
          () => Promise.reject(new Error('missing execute'))
        )
      ).rejects.toThrow(/Invalid arguments:/i);
      // Pre-check passed synthetic URL, dispatch minted a real token, post-mint Ajv rejected it,
      // downstream was never called, AND the minted download ticket was revoked.
      expect(mintSpy).toHaveBeenCalledOnce();
      expect(dispatchedCalls).toHaveLength(0);
      expect(
        (urlStore as unknown as { downloadTokens: Map<string, unknown> }).downloadTokens.size
      ).toBe(0);
    } finally {
      await urlStore.stop();
      auditLogger.stop();
    }

    // 6. Direct multipart POST defers unknown filename/MIME/size arg_policy until parsed, then enforces & rolls back
    const mpDir = mkdtempSync(join(workDir, 'mp-policy-'));
    const mpStore = new UploadStore(makeUploadsConfig(mpDir));
    const mpAgent = makeAgentConfig({
      allow: ['airlock/prepare_upload', 'airlock/delete_upload'],
      arg_policy: {
        'airlock/prepare_upload': {
          filename: [{ glob_allow: ['*.pdf'] }],
          content_type: [{ allow: ['application/pdf'] }],
          size_bytes: [{ equals: 12 }],
        },
      },
    });
    const mpAgents = { a1: mpAgent };
    const mpAllowlist = new AllowlistEngine(mpAgents);
    const mpApp = Fastify({ logger: false });
    await mpApp.register(uploadsApiPlugin, {
      uploadStore: mpStore,
      allowlist: mpAllowlist,
      getAgentConfig: (id) => mpAgents[id as keyof typeof mpAgents],
      authRequired: false,
    });
    await mpApp.listen({ port: 0, host: '127.0.0.1' });
    const mpBase = `http://127.0.0.1:${(mpApp.server.address() as { port: number }).port}`;
    try {
      // Compliant multipart upload without X-Filename header (outer body >> 12 bytes, inner file = 12 bytes)
      const okForm = new FormData();
      okForm.append(
        'file',
        new File([Buffer.from('0123456789ab')], 'report.pdf', { type: 'application/pdf' })
      );
      const okRes = await fetch(`${mpBase}/agents/a1/uploads`, {
        method: 'POST',
        body: okForm,
      });
      expect(okRes.status).toBe(201);
      const okJson = (await okRes.json()) as { filename: string; size_bytes: number };
      expect(okJson.filename).toBe('report.pdf');
      expect(okJson.size_bytes).toBe(12);

      // Disallowed multipart upload still gets rejected (403) and rolled back
      const badForm = new FormData();
      badForm.append(
        'file',
        new File([Buffer.from('0123456789ab')], 'evil.txt', { type: 'text/plain' })
      );
      const badRes = await fetch(`${mpBase}/agents/a1/uploads`, {
        method: 'POST',
        body: badForm,
      });
      expect(badRes.status).toBe(403);

      // Explicit disallowed X-Filename fails fast before parsing
      const fastForm = new FormData();
      fastForm.append(
        'file',
        new File([Buffer.from('0123456789ab')], 'report.pdf', { type: 'application/pdf' })
      );
      const fastBadRes = await fetch(`${mpBase}/agents/a1/uploads`, {
        method: 'POST',
        headers: { 'x-filename': 'disallowed.txt' },
        body: fastForm,
      });
      expect(fastBadRes.status).toBe(403);
    } finally {
      await mpApp.close();
      await mpStore.stop();
    }
  });

  it('aborts pending native opens on disable, revokes per-agent tickets on reload, preserves __proto__ through HITL redaction & OpenAPI JSON, handles uniqueItems :url schemas, and rolls back failed enablement cleanly', async () => {
    // 1. Disable during pending openVerifiedFile in openVerifiedStream & openStreamingMultipart
    const openDir = mkdtempSync(join(workDir, 'pending-open-'));
    const openStore = new UploadStore(makeUploadsConfig(openDir));
    try {
      const prep = openStore.prepareUpload('a1', { filename: 'race.bin' });
      await openStore.completePresignedUpload(prep.uploadToken, {
        stream: Readable.from([Buffer.from('payload-bytes')]),
      });
      const origOpen = (
        openStore as unknown as {
          openVerifiedFile: (rec: unknown) => Promise<unknown>;
        }
      ).openVerifiedFile.bind(openStore);
      let releaseOpen!: () => void;
      vi.spyOn(
        openStore as unknown as { openVerifiedFile: (rec: unknown) => Promise<unknown> },
        'openVerifiedFile'
      ).mockImplementation(async (rec) => {
        const fh = await origOpen(rec);
        await new Promise<void>((resolve) => {
          releaseOpen = resolve;
        });
        return fh;
      });
      const binaryPromise = openStore.openVerifiedStream('a1', prep.uploadId);
      await vi.waitFor(() => expect(releaseOpen).toBeDefined());
      openStore.updateConfig(UploadsConfig.parse({ enabled: false }));
      releaseOpen();
      await expect(binaryPromise).rejects.toThrow(/no longer available/i);
      expect(
        (openStore as unknown as { drainingTransferBytes: number }).drainingTransferBytes
      ).toBe(0);

      // Buffered readBytes also aborts cleanly when revoked mid-open/mid-read
      vi.restoreAllMocks();
      openStore.updateConfig(makeUploadsConfig(openDir));
      const prep2 = openStore.prepareUpload('a1', { filename: 'race-read.txt' });
      await openStore.completePresignedUpload(prep2.uploadToken, {
        stream: Readable.from([Buffer.from('buffered-secret')]),
      });
      const origOpen2 = (
        openStore as unknown as { openVerifiedFile: (rec: unknown) => Promise<unknown> }
      ).openVerifiedFile.bind(openStore);
      let releaseReadOpen!: () => void;
      vi.spyOn(
        openStore as unknown as { openVerifiedFile: (rec: unknown) => Promise<unknown> },
        'openVerifiedFile'
      ).mockImplementation(async (rec) => {
        const fh = await origOpen2(rec);
        await new Promise<void>((resolve) => {
          releaseReadOpen = resolve;
        });
        return fh;
      });
      const readPromise = openStore.readBytes('a1', prep2.uploadId);
      await vi.waitFor(() => expect(releaseReadOpen).toBeDefined());
      openStore.revokeAgentSync('a1');
      releaseReadOpen();
      await expect(readPromise).rejects.toThrow(/no longer available/i);

      // Revocation occurring during fh.close() inside readBytes ALSO aborts cleanly
      vi.restoreAllMocks();
      const prep3 = openStore.prepareUpload('a1', { filename: 'close-race.txt' });
      await openStore.completePresignedUpload(prep3.uploadToken, {
        stream: Readable.from([Buffer.from('close-race-bytes')]),
      });
      const origOpen3 = (
        openStore as unknown as {
          openVerifiedFile: (
            rec: unknown
          ) => Promise<{ readFile: () => Promise<Buffer>; close: () => Promise<void> }>;
        }
      ).openVerifiedFile.bind(openStore);
      vi.spyOn(
        openStore as unknown as { openVerifiedFile: (rec: unknown) => Promise<unknown> },
        'openVerifiedFile'
      ).mockImplementation(async (rec) => {
        const fh = await origOpen3(rec);
        const origClose = fh.close.bind(fh);
        fh.close = async () => {
          openStore.revokeAgentSync('a1');
          return origClose();
        };
        return fh;
      });
      await expect(openStore.readBytes('a1', prep3.uploadId)).rejects.toThrow(
        /no longer available/i
      );

      // OpenAPI buffered upload revoked during async DNS host verification MUST NOT call fetch
      vi.restoreAllMocks();
      const prep4 = openStore.prepareUpload('a1', { filename: 'dns-race.txt' });
      await openStore.completePresignedUpload(prep4.uploadToken, {
        stream: Readable.from([Buffer.from('secret-note')]),
      });
      const dnsSpecPath = join(workDir, 'dns-race-spec.json');
      writeFileSync(
        dnsSpecPath,
        JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'DnsRace', version: '1.0.0' },
          servers: [{ url: 'https://api.example.com' }],
          paths: {
            '/notes': {
              post: {
                operationId: 'postNote',
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: { type: 'object', properties: { text: { type: 'string' } } },
                    },
                  },
                },
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        })
      );
      lookupMock.mockImplementationOnce((async () => {
        openStore.revokeAgentSync('a1');
        return [{ address: '93.184.216.34', family: 4 }];
      }) as unknown as typeof lookup);
      const raceFetch = vi.spyOn(globalThis, 'fetch');
      const raceApi = new OpenApiAdapter(
        'dnsrace',
        { spec: dnsSpecPath, timeout_ms: 5000, max_response_bytes: 100000 },
        DEFAULT_SECURITY,
        openStore
      );
      await raceApi.listTools();
      const raceRes = await raceApi.call({
        tool: 'dnsrace/postNote',
        agentId: 'a1',
        args: { text: `${prep4.ref}:text` },
        meta: {
          uploadPlan: {
            byPointer: {
              '/text': {
                pointer: '/text',
                argPath: 'text',
                uploadId: prep4.uploadId,
                mode: 'text',
              },
            },
            nativePointers: {},
          },
        },
      });
      expect(raceRes.success).toBe(false);
      expect(raceRes.error).toMatch(/no longer available/i);
      expect(raceFetch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await openStore.stop();
    }

    // 2. Per-agent revocation invalidates removed/disabled agent's upload & download tickets while preserving others
    const agentDir = mkdtempSync(join(workDir, 'agent-revoke-'));
    const agentStore = new UploadStore(makeUploadsConfig(agentDir));
    try {
      const a1Pending = agentStore.prepareUpload('a1', { filename: 'p1.txt' });
      const a1Ready = agentStore.prepareUpload('a1', { filename: 'r1.txt' });
      await agentStore.completePresignedUpload(a1Ready.uploadToken, {
        stream: Readable.from([Buffer.from('secret-a1')]),
      });
      const a1Dl = agentStore.mintDownloadUrl('a1', a1Ready.uploadId);
      const a2Ready = agentStore.prepareUpload('a2', { filename: 'r2.txt' });
      await agentStore.completePresignedUpload(a2Ready.uploadToken, {
        stream: Readable.from([Buffer.from('keep-a2')]),
      });
      const a2Dl = agentStore.mintDownloadUrl('a2', a2Ready.uploadId);

      // Disable a1 uploads (while global uploads stay enabled and a2 remains enabled)
      agentStore.reconcileAgents({
        a1: { uploads: { enabled: false, allowed_modes: ['base64'] } },
        a2: {},
      });
      await expect(
        agentStore.completePresignedUpload(a1Pending.uploadToken, {
          stream: Readable.from([Buffer.from('late')]),
        })
      ).rejects.toThrow(/invalid, expired, or already used/i);
      expect(await agentStore.openDownload(a1Dl.downloadToken, true)).toBeUndefined();
      expect(agentStore.getReadyUpload('a1', a1Ready.uploadId)).toBeUndefined();

      // a2 remains untouched and redeemable
      const a2Open = await agentStore.openDownload(a2Dl.downloadToken, true);
      expect(a2Open?.stream).toBeDefined();
      a2Open?.stream?.destroy();

      // Prototype-named agent ("toString") is revoked via Object.hasOwn when removed, AND an
      // in-flight incoming PUT for a revoked agent is immediately aborted and frees shared quota.
      const protoPending = agentStore.prepareUpload('toString', { filename: 'proto.bin' });
      const liveStream = new Readable({ read() {} });
      const inFlightPut = agentStore.completePresignedUpload(protoPending.uploadToken, {
        stream: liveStream,
      });
      liveStream.push(Buffer.alloc(64, 0x33));
      await new Promise((r) => setTimeout(r, 10));
      agentStore.reconcileAgents({ a2: {} });
      await expect(inFlightPut).rejects.toThrow(/cancelled/i);
      expect(
        (agentStore as unknown as { inFlightReservedBytes: number }).inFlightReservedBytes
      ).toBe(0);
    } finally {
      await agentStore.stop();
    }

    // 3. __proto__ is preserved through HitlEngine.create (redactor) AND OpenAPI JSON body serialization
    const protoAudit = new AuditLogger(
      {
        db_path: join(workDir, 'proto-audit.db'),
        log_level: 'error',
        redact_secrets: true,
        redact_fields: ['token', 'secret', 'password'],
      },
      'error'
    );
    const noopProvider: HitlProvider = {
      init: async () => {},
      notify: async () => {},
      stop: async () => {},
    };
    const protoEngine = new HitlEngine(protoAudit, noopProvider, 5000);
    try {
      const rawProtoArgs = JSON.parse(
        '{"__proto__":{"api_token":"super-secret","note":"visible"},"safe":"ok"}'
      ) as Record<string, unknown>;
      const ticket = protoEngine.create({
        agentId: 'a1',
        tool: 'svc/test',
        args: rawProtoArgs,
      });
      const notif = protoEngine.buildNotification(ticket.id)!;
      expect(Object.getPrototypeOf(notif.args)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(notif.args, '__proto__')).toBe(true);
      const rendered = formatNotification(notif);
      expect(rendered).toContain('__proto__');
      expect(rendered).toContain('[REDACTED]');
      expect(rendered).not.toContain('super-secret');
      protoEngine.deny(ticket.id);
    } finally {
      protoAudit.stop();
    }

    const protoSpecPath = join(workDir, 'proto-openapi.json');
    writeFileSync(
      protoSpecPath,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'ProtoAPI', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/items': {
            post: {
              operationId: 'createItem',
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { x: { type: 'number' } },
                      additionalProperties: true,
                    },
                  },
                },
              },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      })
    );
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    let capturedBody = '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    try {
      const apiAdapter = new OpenApiAdapter(
        'protoapi',
        { spec: protoSpecPath, timeout_ms: 5000, max_response_bytes: 100000 },
        DEFAULT_SECURITY
      );
      await apiAdapter.listTools();
      const callArgs = JSON.parse('{"__proto__":{"k":"v"},"x":1}') as Record<string, unknown>;
      const res = await apiAdapter.call({
        tool: 'protoapi/createItem',
        agentId: 'a1',
        args: callArgs,
      });
      expect(res.success).toBe(true);
      expect(capturedBody).toBe('{"__proto__":{"k":"v"},"x":1}');
    } finally {
      fetchSpy.mockRestore();
    }

    // 4. uniqueItems: true array of multiple :url refs succeeds in BOTH request_approval and direct execution
    const uniqDir = mkdtempSync(join(workDir, 'url-unique-'));
    const uniqStore = new UploadStore(makeUploadsConfig(uniqDir), 'http://127.0.0.1:4111');
    const uniqAudit = new AuditLogger(
      {
        db_path: join(workDir, 'uniq-audit.db'),
        log_level: 'error',
        redact_secrets: true,
        redact_fields: [],
      },
      'error'
    );
    const uniqEngine = new HitlEngine(uniqAudit, noopProvider, 5000);
    const uniqBatcher = new HitlBatcher(1);
    const receivedUrls: string[][] = [];
    const uniqPool = {
      isReady: () => true,
      listTools: async () => [
        {
          name: 'ingest_urls',
          description: 'Accept unique URL list',
          inputSchema: {
            type: 'object' as const,
            properties: {
              urls: {
                type: 'array',
                items: {
                  type: 'string',
                  // Enforce canonical 32-byte base64url encoding (43 chars ending in [AEIMQUYcgkosw048])
                  pattern:
                    '^https://airlock\\.example\\.com/uploads/dl/dl_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$',
                },
                uniqueItems: true,
              },
            },
            required: ['urls'],
          },
        },
      ],
      callTool: async (_mcpId: string, _tool: string, args: Record<string, unknown>) => {
        receivedUrls.push(args.urls as string[]);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    } as unknown as ClientPool;
    const uniqAgent = makeAgentConfig({
      allow: ['svc/ingest_urls'],
      ask: ['svc/ingest_urls'],
      uploads: { allowed_modes: ['url'] },
    });
    const uniqAgents = { a1: uniqAgent };
    const uniqAllowlist = new AllowlistEngine(uniqAgents);
    let uniqRegistry!: ToolRegistry;
    const uniqAirlock = new AirlockBackendAdapter({
      hitlEngine: uniqEngine,
      hitlBatcher: uniqBatcher,
      uploadStore: uniqStore,
      getAgentTools: (id) => uniqRegistry.getFilteredWithDecisions(id),
      getAgentConfig: (id) => uniqAgents[id as keyof typeof uniqAgents],
      getRawToolSchema: (toolName) =>
        uniqRegistry.getAllTools().find((t) => t.name === toolName)?.inputSchema,
      getToolBackendKind: (tool, id) => uniqRegistry.getToolBackendKind(tool, id),
    });
    uniqRegistry = new ToolRegistry(
      [new McpBackendAdapter('svc', uniqPool, undefined, uniqStore), uniqAirlock],
      uniqAllowlist,
      uniqAgents
    );
    await uniqRegistry.refresh();
    const uniqChain = buildMiddlewareChain(uniqAgent);
    try {
      const staged = uniqStore.prepareUpload('a1', { filename: 'dup.bin' });
      await uniqStore.completePresignedUpload(staged.uploadToken, {
        stream: Readable.from([Buffer.from('data')]),
      });
      const planPromise = uniqAirlock.call({
        tool: 'airlock/request_approval',
        agentId: 'a1',
        args: {
          reason: 'Upload two unique URLs for the same staged file',
          calls: [
            {
              tool: 'svc/ingest_urls',
              arguments: { urls: [`${staged.ref}:url`, `${staged.ref}:url`] },
            },
          ],
        },
      });
      await vi.waitFor(() => expect(uniqEngine.getPending()).toHaveLength(1));
      uniqEngine.approve(uniqEngine.getPending()[0].id);
      expect((await planPromise).success).toBe(true);

      const execRes = await uniqChain(
        {
          callId: 'c-uniq-1',
          agentId: 'a1',
          agentConfig: uniqAgent,
          toolName: 'svc/ingest_urls',
          args: {
            urls: [`${staged.ref}:url`, `${staged.ref}:url`],
            _airlock: { reason: 'Execute unique URLs' },
          },
          meta: {},
          deps: {
            registry: uniqRegistry,
            allowlist: uniqAllowlist,
            hitlEngine: uniqEngine,
            hitlBatcher: uniqBatcher,
            auditLogger: uniqAudit,
            securityConfig: DEFAULT_SECURITY,
            uploadStore: uniqStore,
          },
          startedAt: Date.now(),
        },
        () => Promise.reject(new Error('missing execute'))
      );
      expect((execRes.result as { isError?: boolean }).isError).toBeUndefined();
      expect(receivedUrls).toHaveLength(1);
      expect(receivedUrls[0]).toHaveLength(2);
      expect(receivedUrls[0][0]).not.toBe(receivedUrls[0][1]);
    } finally {
      await uniqStore.stop();
      uniqAudit.stop();
    }

    // 5. Failed upload enablement during Gateway.reload does NOT publish the failed config
    const busyDir = mkdtempSync(join(workDir, 'busy-dir-'));
    const goodDir = mkdtempSync(join(workDir, 'good-dir-'));
    const holderStore = new UploadStore(makeUploadsConfig(busyDir));
    const baseCfg = GatewayConfig.parse({
      server: { port: 1, host: '127.0.0.1' },
      audit: { db_path: join(workDir, 'reload-audit.db') },
      uploads: { enabled: false },
      agents: { a1: { allow: ['airlock/prepare_upload'] } },
    });
    baseCfg.server.port = 0;
    const gw = new Gateway(baseCfg);
    try {
      await gw.start();
      const failedCfg = GatewayConfig.parse({
        server: { port: 1, host: '127.0.0.1' },
        audit: { db_path: join(workDir, 'reload-audit.db') },
        uploads: { enabled: true, dir: busyDir },
        agents: { a1: { allow: ['airlock/prepare_upload'] } },
      });
      failedCfg.server.port = 0;
      await expect(gw.reload(failedCfg)).rejects.toThrow(
        /already owned by another active Airlock instance/i
      );
      // Correcting uploads.dir on the next reload MUST succeed (prior config remained enabled: false)
      const fixedCfg = GatewayConfig.parse({
        server: { port: 1, host: '127.0.0.1' },
        audit: { db_path: join(workDir, 'reload-audit.db') },
        uploads: { enabled: true, dir: goodDir },
        agents: { a1: { allow: ['airlock/prepare_upload'] } },
      });
      fixedCfg.server.port = 0;
      await expect(gw.reload(fixedCfg)).resolves.toBeUndefined();
    } finally {
      await gw.stop();
      await holderStore.stop();
    }
  });

  it('closes all remaining dispatch-guard, temp-dir teardown, and commit-409 timing windows', async () => {
    // 1. Built-in HttpBackendAdapter + executeHttp re-checks uploadPlan synchronously right before
    //    fetch and closes the opened stream without dispatching when revoked after stream open.
    const httpDir = mkdtempSync(join(workDir, 'http-dispatch-guard-'));
    const httpStore = new UploadStore(makeUploadsConfig(httpDir));
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const httpFetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    try {
      const staged = httpStore.prepareUpload('a1', {
        filename: 'part.bin',
        contentType: 'application/octet-stream',
      });
      await httpStore.completePresignedUpload(staged.uploadToken, {
        stream: Readable.from([Buffer.from('binary-payload')]),
      });
      let closeCalls = 0;
      const origOpen = httpStore.openVerifiedStream.bind(httpStore);
      const openSpy = vi
        .spyOn(httpStore, 'openVerifiedStream')
        .mockImplementationOnce(async (...openArgs) => {
          const opened = await origOpen(...openArgs);
          const origClose = opened.close;
          opened.close = () => {
            closeCalls++;
            origClose();
          };
          // Revoke right after stream setup resolves, before executeHttp reaches fetch()
          httpStore.revokeAgentSync('a1');
          return opened;
        });

      const httpAgent = makeAgentConfig({
        allow: ['http/put'],
        http: { domain_allowlist: ['upload.example.com'] },
      });
      const httpAdapter = new HttpBackendAdapter({ a1: httpAgent }, DEFAULT_SECURITY, httpStore);
      const res = await httpAdapter.call({
        tool: 'http/put',
        agentId: 'a1',
        args: {
          url: 'https://upload.example.com/file',
          body_upload: staged.ref,
        },
        meta: {
          uploadPlan: {
            byPointer: {},
            nativePointers: { '/body_upload': staged.uploadId },
          },
        },
      });
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/no longer available|disabled/i);
      expect(httpFetchSpy).not.toHaveBeenCalled();
      expect(closeCalls).toBe(1);
      await vi.waitFor(() => {
        expect(
          (httpStore as unknown as { activeTransfers: Set<unknown> }).activeTransfers.size
        ).toBe(0);
      });
    } finally {
      httpFetchSpy.mockRestore();
      await httpStore.stop();
    }

    // 2. Pooled McpBackendAdapter forwards the per-attempt dispatch guard to ClientPool.callTool
    const mcpDir = mkdtempSync(join(workDir, 'mcp-pool-guard-'));
    const mcpStore = new UploadStore(makeUploadsConfig(mcpDir));
    try {
      const staged = mcpStore.prepareUpload('a1', {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
      await mcpStore.completePresignedUpload(staged.uploadToken, {
        stream: Readable.from([Buffer.from('sensitive text')]),
      });
      let receivedBeforeSend: (() => void) | undefined;
      const mockPool = {
        isReady: () => true,
        listTools: async () => [],
        callTool: async (
          _mcpId: string,
          _tool: string,
          _args: Record<string, unknown>,
          _requestMeta?: Record<string, unknown>,
          beforeSend?: () => void
        ) => {
          receivedBeforeSend = beforeSend;
          // Simulate revocation happening during a reconnect/retry wait inside the pool
          mcpStore.revokeAgentSync('a1');
          beforeSend?.();
          return { content: [{ type: 'text', text: 'should not reach' }] };
        },
      } as unknown as ClientPool;
      const mcpAdapter = new McpBackendAdapter('srv', mockPool, undefined, mcpStore);
      const res = await mcpAdapter.call({
        tool: 'srv/save_note',
        agentId: 'a1',
        args: { text: `${staged.ref}:text` },
        meta: {
          uploadPlan: {
            byPointer: { '/text': { uploadId: staged.uploadId, mode: 'text' } },
            nativePointers: {},
          },
        },
      });
      expect(receivedBeforeSend).toBeTypeOf('function');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/no longer available/i);
    } finally {
      await mcpStore.stop();
    }

    // 3. Auto-created temp staging directory keeps .airlock-owner.lock stable during child cleanup
    //    and removes itself cleanly via non-recursive rmdir without recursive rm of the lock path.
    const autoStore = new UploadStore(UploadsConfig.parse({ enabled: true }));
    const autoDir = autoStore.getStagingDir();
    try {
      const staged = autoStore.prepareUpload('a1', { filename: 'temp.txt' });
      await autoStore.completePresignedUpload(staged.uploadToken, {
        stream: Readable.from([Buffer.from('hello temp')]),
      });
      expect(existsSync(join(autoDir, '.airlock-owner.lock'))).toBe(true);
      expect(existsSync(join(autoDir, staged.uploadId))).toBe(true);
    } finally {
      await autoStore.stop();
    }
    expect(existsSync(autoDir)).toBe(false);

    // 4. Revocation during commit (rename/stat ENOENT) translates to HTTP 409 (not 500) and
    //    never leaks the filesystem path to the client.
    const commitDir = mkdtempSync(join(workDir, 'commit-409-'));
    const commitStore = new UploadStore(makeUploadsConfig(commitDir));
    const app = Fastify();
    await app.register(uploadsApiPlugin, {
      uploadStore: commitStore,
      enableDirectRoutes: false,
      getRequestSecurity: () => ({ authRequired: false, allowedOrigins: [] }),
    });
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const prepared = commitStore.prepareUpload('a1', {
        filename: 'race.bin',
        contentType: 'application/octet-stream',
      });
      // Simulate revocation winning the race right after the post-mkdir check passes and before
      // rename() executes: revokeAgentSync removes the record AND its directory, so rename() fails
      // with a real OS ENOENT containing the filesystem path.
      const storeInternal = commitStore as unknown as {
        uploads: Map<string, unknown>;
      };
      const origGet = storeInternal.uploads.get.bind(storeInternal.uploads);
      let getCount = 0;
      storeInternal.uploads.get = (id: string) => {
        const rec = origGet(id);
        if (id === prepared.uploadId && rec && ++getCount === 3) {
          commitStore.revokeAgentSync('a1');
        }
        return rec;
      };

      const putRes = await fetch(`${baseUrl}${prepared.uploadPath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('bytes racing revocation during rename'),
      });
      const body = (await putRes.json()) as { error?: string };
      expect(putRes.status).toBe(409);
      expect(body.error).toBe('Upload was cancelled before completion.');
      expect(body.error).not.toContain(commitDir);
      expect(existsSync(join(commitDir, prepared.uploadId))).toBe(false);
    } finally {
      await app.close();
      await commitStore.stop();
    }

    // 5. Stdio transport (both pooled StdioMcpClient and sandboxed McpBackendAdapter) guards
    //    `transport.send` synchronously so revocation during SDK preparation (outputValidator /
    //    buildSendOptions await) results in ZERO tool-call writes to child stdin.
    const stdioServerScript = join(workDir, 'fake-mcp-stdio.mjs');
    writeFileSync(
      stdioServerScript,
      `
        import { appendFileSync } from 'fs';
        import { createInterface } from 'readline';
        const logPath = process.argv[2];
        const rl = createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          if (!line.trim()) return;
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'fake-stdio', version: '1.0.0' },
              },
            }) + '\\n');
          } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'save', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] },
            }) + '\\n');
          } else if (msg.method === 'tools/call') {
            appendFileSync(logPath, line + '\\n');
            if (msg.params?.name === 'hang') {
              // Hold the response so the client times out and sends notifications/cancelled
              return;
            }
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: 'written' }] },
            }) + '\\n');
          } else if (msg.method === 'notifications/cancelled') {
            appendFileSync(logPath + '.cancelled', line + '\\n');
          }
        });
      `
    );

    const pooledLogPath = join(workDir, 'pooled-stdio-calls.log');
    const pooledDir = mkdtempSync(join(workDir, 'stdio-pooled-guard-'));
    const pooledStore = new UploadStore(makeUploadsConfig(pooledDir));
    const stdioClient = new StdioMcpClient(
      'fake-stdio',
      process.execPath,
      [stdioServerScript, pooledLogPath],
      undefined,
      'pipe',
      false
    );
    try {
      await stdioClient.connect();
      const staged = pooledStore.prepareUpload('a1', {
        filename: 'pooled.txt',
        contentType: 'text/plain',
      });
      await pooledStore.completePresignedUpload(staged.uploadToken, {
        stream: Readable.from([Buffer.from('top-secret-pooled')]),
      });
      // Hook the real SDK Client's async outputValidator lookup so revocation fires AFTER
      // StdioMcpClient.callTool's entry check and BEFORE transport.send writes to stdin.
      const sdkCache = (
        stdioClient as unknown as {
          client: {
            _cache: {
              outputValidator: (name: string, compile: unknown) => Promise<unknown>;
            };
          };
        }
      ).client._cache;
      const origOutputValidator = sdkCache.outputValidator.bind(sdkCache);
      sdkCache.outputValidator = async (name: string, compile: unknown) => {
        await Promise.resolve();
        pooledStore.revokeAgentSync('a1');
        return origOutputValidator(name, compile);
      };
      const plan = {
        byPointer: {
          '/text': {
            pointer: '/text',
            argPath: 'text',
            uploadId: staged.uploadId,
            mode: 'text' as const,
          },
        },
        nativePointers: {},
      };
      await expect(
        stdioClient.callTool('save', { text: 'top-secret-pooled' }, undefined, () =>
          assertUploadPlanActive(plan, 'a1', pooledStore)
        )
      ).rejects.toThrow(/no longer available/i);
      await new Promise((r) => setTimeout(r, 40));
      expect(existsSync(pooledLogPath)).toBe(false);

      // Post-dispatch revocation must NOT block SDK notifications/cancelled frames on timeout
      sdkCache.outputValidator = origOutputValidator;
      const hangStaged = pooledStore.prepareUpload('a1', {
        filename: 'hang.txt',
        contentType: 'text/plain',
      });
      await pooledStore.completePresignedUpload(hangStaged.uploadToken, {
        stream: Readable.from([Buffer.from('in-flight')]),
      });
      const hangPlan = {
        byPointer: {
          '/text': {
            pointer: '/text',
            argPath: 'text',
            uploadId: hangStaged.uploadId,
            mode: 'text' as const,
          },
        },
        nativePointers: {},
      };
      const rawClient = (
        stdioClient as unknown as {
          client: {
            callTool: (
              req: { name: string; arguments: Record<string, unknown> },
              opts?: { timeout?: number }
            ) => Promise<unknown>;
          };
        }
      ).client;
      const origCallTool = rawClient.callTool.bind(rawClient);
      rawClient.callTool = (req, opts) => origCallTool(req, { ...opts, timeout: 120 });
      const hangPromise = stdioClient.callTool('hang', { text: 'in-flight' }, undefined, () =>
        assertUploadPlanActive(hangPlan, 'a1', pooledStore)
      );
      await vi.waitFor(() => expect(existsSync(pooledLogPath)).toBe(true));
      // Revoke AFTER tools/call was dispatched to the child, BEFORE the request times out
      pooledStore.revokeAgentSync('a1');
      await expect(hangPromise).rejects.toThrow(/timed out/i);
      await vi.waitFor(() => expect(existsSync(`${pooledLogPath}.cancelled`)).toBe(true));
    } finally {
      await stdioClient.stop();
      await pooledStore.stop();
    }

    // Sandboxed McpBackendAdapter also guards transport.send after SDK async preparation
    const sandboxLogPath = join(workDir, 'sandbox-stdio-calls.log');
    const sandboxDir = mkdtempSync(join(workDir, 'stdio-sandbox-guard-'));
    const sandboxStore = new UploadStore(makeUploadsConfig(sandboxDir));
    const wrapSpy = vi
      .spyOn(SandboxManager, 'wrapWithSandbox')
      .mockImplementationOnce(async (cmd) => cmd);
    const origConnect = Client.prototype.connect;
    const connectSpy = vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async function (
      this: Client,
      ...connectArgs
    ) {
      await origConnect.apply(this, connectArgs);
      const cache = (
        this as unknown as {
          _cache: { outputValidator: (name: string, compile: unknown) => Promise<unknown> };
        }
      )._cache;
      const origOv = cache.outputValidator.bind(cache);
      cache.outputValidator = async (name: string, compile: unknown) => {
        await Promise.resolve();
        sandboxStore.revokeAgentSync('a1');
        return origOv(name, compile);
      };
    });
    try {
      const staged = sandboxStore.prepareUpload('a1', {
        filename: 'sandbox.txt',
        contentType: 'text/plain',
      });
      await sandboxStore.completePresignedUpload(staged.uploadToken, {
        stream: Readable.from([Buffer.from('top-secret-sandbox')]),
      });
      const dummyPool = { isReady: () => true } as unknown as ClientPool;
      const sandboxAdapter = new McpBackendAdapter(
        'srv',
        dummyPool,
        {
          type: 'stdio',
          command: process.execPath,
          args: [stdioServerScript, sandboxLogPath],
        },
        sandboxStore
      );
      const res = await sandboxAdapter.call({
        tool: 'srv/save',
        agentId: 'a1',
        args: { text: `${staged.ref}:text` },
        meta: {
          sandbox: {
            filesystem: { allow_write: [], deny_read: [], deny_write: [] },
            network: { allowed_domains: [], denied_domains: [] },
          },
          uploadPlan: {
            byPointer: {
              '/text': {
                pointer: '/text',
                argPath: 'text',
                uploadId: staged.uploadId,
                mode: 'text',
              },
            },
            nativePointers: {},
          },
        },
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/no longer available/i);
      await new Promise((r) => setTimeout(r, 40));
      expect(existsSync(sandboxLogPath)).toBe(false);
    } finally {
      connectSpy.mockRestore();
      wrapSpy.mockRestore();
      await sandboxStore.stop();
    }

    // 6. Temp-dir teardown requires a confirmed tombstone, cleans sidecars before unlinking the
    //    lock file, rejects retired lock inodes, and never harms a successor in a live handoff.
    const failedTombstoneStore = new UploadStore(UploadsConfig.parse({ enabled: true }));
    const failedTombstoneDir = failedTombstoneStore.getStagingDir();
    try {
      const db = (failedTombstoneStore as unknown as { ownerLockDb: Database.Database })
        .ownerLockDb;
      vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
        throw new Error('simulated tombstone failure');
      });
      await failedTombstoneStore.stop();
      // Tombstone failed -> `.airlock-owner.lock` MUST NOT have been unlinked
      expect(existsSync(join(failedTombstoneDir, '.airlock-owner.lock'))).toBe(true);
    } finally {
      rmSync(failedTombstoneDir, { recursive: true, force: true });
    }

    // A retired lock file (retired = 1) MUST reject acquisition even when unlocked
    const retiredDir = mkdtempSync(join(workDir, 'retired-lock-'));
    const retiredDb = new Database(join(retiredDir, '.airlock-owner.lock'));
    retiredDb.exec(
      'CREATE TABLE owner_lock_v2 (id INTEGER PRIMARY KEY, pid INTEGER, retired INTEGER NOT NULL DEFAULT 0); INSERT INTO owner_lock_v2 (id, pid, retired) VALUES (1, 999999, 1);'
    );
    retiredDb.close();
    expect(() => new UploadStore(makeUploadsConfig(retiredDir))).toThrow(/already owned/i);

    // Multi-process handoff during active stop(): child races acquisition while parent is still
    // live (proving exclusion), then continues through parent.stop(). Either teardown completes
    // cleanly or a successor that claims the directory after unlink keeps its lock, journal, and
    // staged file completely intact.
    const handoffStore = new UploadStore(UploadsConfig.parse({ enabled: true }));
    const handoffDir = handoffStore.getStagingDir();
    const storeUrl = new URL('../src/uploads/store.ts', import.meta.url).href;
    const schemaUrl = new URL('../src/config/schema.ts', import.meta.url).href;
    const handoffScript = `
      import { existsSync } from 'fs';
      import { join } from 'path';
      import { Readable } from 'stream';
      import { UploadStore } from ${JSON.stringify(storeUrl)};
      import { UploadsConfig } from ${JSON.stringify(schemaUrl)};
      (async () => {
        const dir = process.argv[1];
        const deadline = Date.now() + 4000;
        let sawBlocked = false;
        let acquired = null;
        while (Date.now() < deadline && !acquired) {
          if (!existsSync(dir)) {
            process.stdout.write(sawBlocked ? 'REMOVED_CLEANLY\\n' : 'MISSING_EARLY\\n');
            process.exit(0);
          }
          try {
            acquired = new UploadStore(UploadsConfig.parse({ enabled: true, dir }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/already owned|SQLITE_BUSY|SQLITE_LOCKED|ENOENT/i.test(msg)) {
              throw err;
            }
            if (!sawBlocked) {
              sawBlocked = true;
              process.stdout.write('BLOCKED_ONCE\\n');
            }
            await new Promise((r) => setTimeout(r, 5));
          }
        }
        if (!acquired) {
          process.stdout.write('TIMEOUT\\n');
          process.exit(1);
        }
        // Once acquisition succeeds, NEVER retry or mask errors as REMOVED_CLEANLY: any staging,
        // readback, or lock-survival failure must fail the test immediately.
        const p = acquired.prepareUpload('successor', { filename: 'keep.bin' });
        await acquired.completePresignedUpload(p.uploadToken, {
          stream: Readable.from([Buffer.from('successor-ok')]),
        });
        await new Promise((r) => setTimeout(r, 80));
        const ok =
          existsSync(join(dir, '.airlock-owner.lock')) &&
          (await acquired.readBytes('successor', p.uploadId)).bytes.toString() === 'successor-ok';
        await acquired.stop();
        if (!sawBlocked || !ok) {
          process.stdout.write('HANDOFF_CORRUPT\\n');
          process.exit(1);
        }
        process.stdout.write('HANDOFF_OK\\n');
      })().catch((err) => {
        process.stderr.write(String(err) + '\\n');
        process.exit(1);
      });
    `;
    try {
      const staged = handoffStore.prepareUpload('a1', { filename: 'old.txt' });
      await handoffStore.completePresignedUpload(staged.uploadToken, {
        stream: Readable.from([Buffer.from('old-owner')]),
      });
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', handoffScript, handoffDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdoutBuf = '';
      await new Promise<void>((resolveBlocked, rejectBlocked) => {
        const timer = setTimeout(() => rejectBlocked(new Error('child did not block')), 4000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString();
          if (stdoutBuf.includes('BLOCKED_ONCE')) {
            clearTimeout(timer);
            resolveBlocked();
          }
        });
        child.once('exit', () => {
          clearTimeout(timer);
          resolveBlocked();
        });
      });
      // Tear down parent concurrently while child is actively racing acquisition
      await handoffStore.stop();
      const outcome = await new Promise<string>((resolveExit) => {
        if (child.exitCode !== null) {
          resolveExit(stdoutBuf.trim());
          return;
        }
        child.once('exit', () => resolveExit(stdoutBuf.trim()));
      });
      const lines = outcome.split('\n').map((l) => l.trim());
      expect(child.exitCode).toBe(0);
      expect(lines).toContain('BLOCKED_ONCE');
      expect(['REMOVED_CLEANLY', 'HANDOFF_OK']).toContain(lines[lines.length - 1]);
    } finally {
      await handoffStore.stop();
      rmSync(handoffDir, { recursive: true, force: true });
    }
  });
});
