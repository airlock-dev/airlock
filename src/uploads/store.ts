import { createHash, randomBytes } from 'crypto';
import {
  constants as fsConstants,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  type WriteStream,
} from 'fs';
import { lstat, mkdir, open, realpath, rename, rm, stat, type FileHandle } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve, sep } from 'path';
import { Readable, Transform } from 'stream';
import Database from 'better-sqlite3';
import { UploadsConfig, type AgentUploadsConfig } from '../config/schema.js';
import { sha256Hex } from '../security/request.js';
import { childLogger } from '../util/logger.js';
import {
  UPLOAD_ID_PATTERN,
  formatUploadRef,
  inferMimeType,
  matchesMimeAllowlist,
  normalizeMimeType,
  sanitizeFilename,
  toWellFormedUnicode,
} from './refs.js';

const log = childLogger('uploads');

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const SWEEP_INTERVAL_MS = 60_000;
const OWNER_LOCK_FILENAME = '.airlock-owner.lock';
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const SESSION_AGENT_RECORD_MULTIPLIER = 4;
const MIN_GLOBAL_RECORD_CAP = 2000;
/** Block size for staging-time per-chunk SHA-256 authentication on streamed delivery (256 KiB). */
const STREAM_VERIFY_BLOCK_BYTES = 256 * 1024;
/** Canonical staging directories currently owned by live UploadStore instances in this process. */
const ACTIVE_OWNED_DIRS = new Set<string>();

export class UploadHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'UploadHttpError';
  }
}

export interface StagedUploadRecord {
  id: string;
  agentId: string;
  sessionId?: string;
  status: 'pending' | 'uploading' | 'ready';
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  /** Fixed block size used to compute `blockDigests` at staging time. */
  blockSize: number;
  /** Concatenated 32-byte SHA-256 digests per block so streaming delivery authenticates every chunk before releasing it. */
  blockDigests: Buffer;
  diskPath: string;
  /** Filesystem identity captured at commit time to detect external replacement/modification. */
  fileIdentity?: {
    dev: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
  };
  createdAt: number;
  expiresAt: number;
  maxBytes: number;
  allowedMimeTypes: string[];
  /** Explicit filename provided at prepare time (vs default fallback). */
  explicitFilename: boolean;
  /** Explicit non-generic content type provided at prepare time. */
  explicitContentType: boolean;
  /** Number of in-flight tool calls or active downloads referencing this upload. */
  inFlightRefs: number;
}

export interface PreparedUploadResult {
  uploadId: string;
  ref: string;
  uploadToken: string;
  uploadPath: string;
  uploadUrl: string;
  method: 'PUT';
  filename: string;
  contentType: string;
  expiresAt: string;
  maxBytes: number;
}

export interface CompletedUploadInfo {
  upload_id: string;
  ref: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  expires_at: string;
}

export type MultipartFieldSpec =
  | { kind: 'text'; name: string; value: string }
  | { kind: 'upload'; name: string; uploadId: string };

export interface StreamingMultipartBody {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number;
  close: () => void;
}

interface DownloadTicket {
  uploadId: string;
  agentId: string;
  sessionId?: string;
  expiresAt: number;
}

interface ActiveTransfer {
  agentId: string;
  bytes: number;
  draining: boolean;
  abort: () => void;
}

export function effectiveMaxFileBytes(
  globalConfig: UploadsConfig,
  agentConfig?: AgentUploadsConfig
): number {
  // Per-agent max_file_bytes overrides the default (letting e.g. a video or 3D-print agent accept
  // larger files without widening every other agent), still bounded by global max_total_bytes.
  const desired = agentConfig?.max_file_bytes ?? globalConfig.max_file_bytes;
  return Math.min(desired, globalConfig.max_total_bytes);
}

export function effectiveMaxFiles(
  globalConfig: UploadsConfig,
  agentConfig?: AgentUploadsConfig
): number {
  if (agentConfig?.max_files === undefined) return globalConfig.max_files_per_agent;
  return Math.min(globalConfig.max_files_per_agent, agentConfig.max_files);
}

function isMimeAllowed(
  mimeType: string,
  globalConfig: UploadsConfig,
  agentConfig?: AgentUploadsConfig
): boolean {
  if (!matchesMimeAllowlist(mimeType, globalConfig.allowed_mime_types)) return false;
  if (
    agentConfig?.allowed_mime_types &&
    agentConfig.allowed_mime_types.length > 0 &&
    !matchesMimeAllowlist(mimeType, agentConfig.allowed_mime_types)
  ) {
    return false;
  }
  return true;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizeRequestHost(raw?: string): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(',')[0]?.trim().toLowerCase();
  return first || undefined;
}

function hostMatchesPublicUrl(candidateUrl: string, requestHost: string): boolean {
  try {
    const parsed = new URL(candidateUrl);
    if (parsed.host.toLowerCase() === requestHost) return true;
    const defaultPort =
      parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '';
    if (defaultPort && `${parsed.hostname.toLowerCase()}:${defaultPort}` === requestHost) {
      return true;
    }
    return !parsed.port && parsed.hostname.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

function escapeMultipartParam(value: string): string {
  return toWellFormedUnicode(value)
    .replace(/[\r\n]/g, '_')
    .replace(/["\\]/g, '_');
}

/**
 * Incremental whole-file + fixed-block SHA-256 builder used during upload staging so streaming
 * delivery can authenticate every block against staging-time digests BEFORE emitting a single
 * unverified byte downstream.
 */
class ChunkedDigestBuilder {
  private readonly wholeHash = createHash('sha256');
  private blockHash = createHash('sha256');
  private blockBytes = 0;
  private readonly digests: Buffer[] = [];

  constructor(private readonly blockSize = STREAM_VERIFY_BLOCK_BYTES) {}

  update(buf: Buffer): void {
    if (buf.byteLength === 0) return;
    this.wholeHash.update(buf);
    let offset = 0;
    while (offset < buf.byteLength) {
      const take = Math.min(this.blockSize - this.blockBytes, buf.byteLength - offset);
      this.blockHash.update(buf.subarray(offset, offset + take));
      this.blockBytes += take;
      offset += take;
      if (this.blockBytes === this.blockSize) {
        this.digests.push(this.blockHash.digest());
        this.blockHash = createHash('sha256');
        this.blockBytes = 0;
      }
    }
  }

  finish(): { sha256: string; blockSize: number; blockDigests: Buffer } {
    if (this.blockBytes > 0) {
      this.digests.push(this.blockHash.digest());
      this.blockBytes = 0;
    }
    return {
      sha256: this.wholeHash.digest('hex'),
      blockSize: this.blockSize,
      blockDigests: Buffer.concat(this.digests),
    };
  }
}

/**
 * Wrap a verified `FileHandle` in a streaming readable that authenticates each fixed-size block
 * against its staging-time SHA-256 digest BEFORE emitting any bytes of that block downstream, and
 * verifies the exact byte count and whole-file SHA-256 before completing.
 */
function createDigestVerifyingStream(
  fh: FileHandle,
  record: StagedUploadRecord,
  onDone?: () => void,
  onFdClosed?: () => void
): Readable {
  const wholeHash = createHash('sha256');
  const blockSize = record.blockSize > 0 ? record.blockSize : STREAM_VERIFY_BLOCK_BYTES;
  const expectedBlockCount = Math.floor(record.blockDigests.byteLength / 32);
  let blockIndex = 0;
  let bytesRead = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let released = false;
  let fdClosed = false;

  const release = () => {
    if (released) return;
    released = true;
    onDone?.();
  };
  const markFdClosed = () => {
    if (fdClosed) return;
    fdClosed = true;
    onFdClosed?.();
  };

  const verifyBlock = (block: Buffer): Error | undefined => {
    if (blockIndex >= expectedBlockCount) {
      return new Error(`Staged upload "${record.id}" exceeded expected authenticated block count.`);
    }
    const actualDigest = createHash('sha256').update(block).digest();
    const expectedDigest = record.blockDigests.subarray(blockIndex * 32, (blockIndex + 1) * 32);
    if (Buffer.compare(actualDigest, expectedDigest) !== 0) {
      return new Error(
        `Staged upload "${record.id}" failed block SHA-256 integrity verification before emission.`
      );
    }
    blockIndex += 1;
    wholeHash.update(block);
    return undefined;
  };

  const takePendingBlock = (size: number): Buffer => {
    const only = pending[0];
    if (pending.length === 1 && only && only.byteLength === size) {
      pending = [];
      pendingBytes = 0;
      return only;
    }
    const combined = Buffer.concat(pending, pendingBytes);
    const block = combined.subarray(0, size);
    const rest = combined.subarray(size);
    pending = rest.byteLength > 0 ? [rest] : [];
    pendingBytes = rest.byteLength;
    return block;
  };

  const source = fh.createReadStream({ autoClose: true, highWaterMark: blockSize });
  source.once('close', markFdClosed);

  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.byteLength;
      if (bytesRead > record.sizeBytes) {
        callback(new Error(`Staged upload "${record.id}" exceeded verified byte length.`));
        return;
      }
      if (chunk.byteLength > 0) {
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
      }
      while (pendingBytes >= blockSize) {
        const block = takePendingBlock(blockSize);
        const err = verifyBlock(block);
        if (err) {
          callback(err);
          return;
        }
        this.push(block);
      }
      callback();
    },
    flush(callback) {
      let finalBlock: Buffer | undefined;
      if (pendingBytes > 0) {
        finalBlock = takePendingBlock(pendingBytes);
        const err = verifyBlock(finalBlock);
        if (err) {
          callback(err);
          return;
        }
      }
      const actualHash = wholeHash.digest('hex');
      if (
        bytesRead !== record.sizeBytes ||
        blockIndex !== expectedBlockCount ||
        actualHash !== record.sha256
      ) {
        callback(new Error(`Staged upload "${record.id}" failed SHA-256 integrity verification.`));
        return;
      }
      if (finalBlock && finalBlock.byteLength > 0) {
        this.push(finalBlock);
      }
      callback();
    },
    destroy(err, callback) {
      pending = [];
      pendingBytes = 0;
      if (!source.destroyed) source.destroy();
      if (source.closed) markFdClosed();
      release();
      callback(err);
    },
  });

  source.on('error', (err) => {
    verifier.destroy(err);
  });
  verifier.once('close', () => {
    if (!source.destroyed) source.destroy();
    if (source.closed) markFdClosed();
    release();
  });

  source.pipe(verifier);
  return verifier;
}

/**
 * Build a streaming `multipart/form-data` body from text-only parts (used when an OpenAPI
 * multipart endpoint is called without any staged upload fields and no `UploadStore` is active).
 */
export function buildStreamingMultipartFromParts(
  parts: MultipartFieldSpec[]
): StreamingMultipartBody {
  const boundary = `----AirlockBoundary${randomBytes(16).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.kind !== 'text') {
      throw new Error('Cannot stream upload part without an active UploadStore.');
    }
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartParam(part.name)}"\r\n\r\n`;
    chunks.push(Buffer.from(header, 'utf8'), Buffer.from(part.value, 'utf8'), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const totalBytes = chunks.reduce((sum, b) => sum + b.byteLength, 0);
  const nodeStream = Readable.from(chunks);
  return {
    stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: totalBytes,
    close: () => {
      if (!nodeStream.destroyed) nodeStream.destroy();
    },
  };
}

export interface UploadStoreOptions {
  streamIdleTimeoutMs?: number;
}

export class UploadStore {
  private config: UploadsConfig;
  private resolvedDir: string;
  private canonicalDir = '';
  /** True when this store created its own unique temp dir (no explicit `uploads.dir` configured). */
  private ownedTempDir: boolean;
  /** Kernel-held SQLite EXCLUSIVE lock handle for an explicitly configured `uploads.dir`. */
  private ownerLockDb?: Database.Database;
  private runtimeBaseUrl: string;
  private streamIdleTimeoutMs: number;
  private uploads = new Map<string, StagedUploadRecord>();
  /** sha256(rawUploadToken) -> uploadId */
  private uploadTokens = new Map<string, string>();
  /** sha256(rawDownloadToken) -> DownloadTicket */
  private downloadTokens = new Map<string, DownloadTicket>();
  /** Live bytes reserved by concurrent in-flight upload streams against `max_total_bytes`. */
  private inFlightReservedBytes = 0;
  /** Active download / binary / multipart streams so disable/stop can abort them and keep accounting accurate until their fds close. */
  private activeTransfers = new Set<ActiveTransfer>();
  /** Bytes held by aborted/unlinked transfers whose OS file descriptors have not finished closing yet. */
  private drainingTransferBytes = 0;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private dirReady = false;

  constructor(
    config?: UploadsConfig,
    runtimeBaseUrl = 'http://127.0.0.1:4111',
    options: UploadStoreOptions = {}
  ) {
    this.config = config ?? UploadsConfig.parse({});
    this.ownedTempDir = !this.config.dir;
    this.resolvedDir = this.config.dir ? resolve(this.config.dir) : '';
    this.runtimeBaseUrl = stripTrailingSlash(runtimeBaseUrl);
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    if (this.config.enabled) {
      this.ensureDir();
      this.startSweeper();
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): UploadsConfig {
    return this.config;
  }

  getStagingDir(): string {
    if (this.config.enabled && !this.dirReady) {
      this.ensureDir();
    }
    return this.resolvedDir;
  }

  setRuntimeBaseUrl(url: string): void {
    this.runtimeBaseUrl = stripTrailingSlash(url);
  }

  getPublicBaseUrl(opts: { agentPublicUrl?: string; requestHost?: string } = {}): string {
    if (opts.agentPublicUrl) {
      return stripTrailingSlash(opts.agentPublicUrl);
    }
    const allowed: string[] = [];
    if (this.config.public_url) allowed.push(stripTrailingSlash(this.config.public_url));
    for (const url of this.config.public_urls) {
      const normalized = stripTrailingSlash(url);
      if (!allowed.includes(normalized)) allowed.push(normalized);
    }

    const requestHost = normalizeRequestHost(opts.requestHost);
    if (requestHost && allowed.length > 0) {
      const matched = allowed.find((candidate) => hostMatchesPublicUrl(candidate, requestHost));
      if (matched) return matched;
    }

    return allowed[0] ?? this.runtimeBaseUrl;
  }

  getInternalBaseUrl(): string {
    return stripTrailingSlash(
      this.config.internal_url ??
        this.config.public_url ??
        this.config.public_urls[0] ??
        this.runtimeBaseUrl
    );
  }

  updateConfig(nextConfig?: UploadsConfig): void {
    const next = nextConfig ?? UploadsConfig.parse({});
    const wasEnabled = this.config.enabled;
    if (!wasEnabled && next.enabled) {
      const prevOwned = this.ownedTempDir;
      const prevResolved = this.resolvedDir;
      const prevCanonical = this.canonicalDir;
      const prevDirReady = this.dirReady;
      this.ownedTempDir = !next.dir;
      this.resolvedDir = next.dir ? resolve(next.dir) : '';
      this.canonicalDir = '';
      this.dirReady = false;
      try {
        this.ensureDir();
      } catch (err) {
        this.ownedTempDir = prevOwned;
        this.resolvedDir = prevResolved;
        this.canonicalDir = prevCanonical;
        this.dirReady = prevDirReady;
        throw err;
      }
      this.config = next;
      this.startSweeper();
    } else if (wasEnabled && !next.enabled) {
      this.config = next;
      this.stopSweeper();
      this.clearAllSync();
    } else {
      this.config = next;
    }
  }

  /**
   * Immediately revoke all staged uploads, upload/download tickets, and active transfers for any
   * agent that was removed from config or had `uploads.enabled: false` set while global uploads
   * remain enabled.
   */
  reconcileAgents(agents: Record<string, { uploads?: AgentUploadsConfig }>): void {
    const revokedAgents = new Set<string>();
    const isRevoked = (agentId: string): boolean => {
      if (!Object.prototype.hasOwnProperty.call(agents, agentId)) return true;
      const cfg = agents[agentId];
      return !cfg || cfg.uploads?.enabled === false;
    };
    for (const rec of this.uploads.values()) {
      if (isRevoked(rec.agentId)) revokedAgents.add(rec.agentId);
    }
    for (const ticket of this.downloadTokens.values()) {
      if (isRevoked(ticket.agentId)) revokedAgents.add(ticket.agentId);
    }
    for (const transfer of this.activeTransfers) {
      if (isRevoked(transfer.agentId)) revokedAgents.add(transfer.agentId);
    }
    for (const agentId of revokedAgents) {
      this.revokeAgentSync(agentId);
    }
  }

  revokeAgentSync(agentId: string): void {
    for (const transfer of Array.from(this.activeTransfers)) {
      if (transfer.agentId !== agentId) continue;
      if (!transfer.draining) {
        transfer.draining = true;
        this.drainingTransferBytes += transfer.bytes;
      }
      transfer.abort();
    }
    for (const [id, rec] of Array.from(this.uploads.entries())) {
      if (rec.agentId === agentId) {
        this.deleteRecordSync(id);
      }
    }
    for (const [tokenHash, ticket] of Array.from(this.downloadTokens.entries())) {
      if (ticket.agentId === agentId) {
        this.downloadTokens.delete(tokenHash);
      }
    }
  }

  prepareUpload(
    agentId: string,
    opts: {
      filename: string;
      contentType?: string;
      sizeBytes?: number;
      agentLimits?: AgentUploadsConfig;
      requestHost?: string;
      sessionId?: string;
    }
  ): PreparedUploadResult {
    this.assertEnabled(opts.agentLimits);
    this.sweepExpired();

    const maxBytes = effectiveMaxFileBytes(this.config, opts.agentLimits);
    const maxFiles = effectiveMaxFiles(this.config, opts.agentLimits);

    if (opts.sizeBytes !== undefined) {
      if (!Number.isFinite(opts.sizeBytes) || opts.sizeBytes < 0) {
        throw new Error('size_bytes must be a non-negative number.');
      }
      if (opts.sizeBytes > maxBytes) {
        throw new Error(
          `Declared file size (${opts.sizeBytes} bytes) exceeds limit of ${maxBytes} bytes.`
        );
      }
      if (
        this.totalStoredBytes() + this.inFlightReservedBytes + opts.sizeBytes >
        this.config.max_total_bytes
      ) {
        throw new Error(
          `Upload would exceed gateway staged upload storage quota (${this.config.max_total_bytes} bytes).`
        );
      }
    }

    this.assertRecordQuota(agentId, maxFiles, opts.sessionId, false);

    const filename = sanitizeFilename(opts.filename);
    const normalizedProvided = normalizeMimeType(opts.contentType);
    if (opts.contentType && !normalizedProvided) {
      throw new Error(`Invalid content_type: "${opts.contentType}".`);
    }
    const contentType = inferMimeType(filename, normalizedProvided);
    if (!isMimeAllowed(contentType, this.config, opts.agentLimits)) {
      throw new Error(`MIME type "${contentType}" is not allowed for uploads.`);
    }

    // 128-bit capability ID: short (22 base64url chars) yet unguessable across concurrent sessionless threads.
    const id = `upl_${randomBytes(16).toString('base64url')}`;
    const uploadToken = `up_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const expiresAt = now + this.config.ticket_ttl_ms;

    this.ensureDir();
    const diskPath = this.safeDiskPath(id, filename);

    const record: StagedUploadRecord = {
      id,
      agentId,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      status: 'pending',
      filename,
      contentType,
      sizeBytes: 0,
      sha256: '',
      blockSize: STREAM_VERIFY_BLOCK_BYTES,
      blockDigests: Buffer.alloc(0),
      diskPath,
      createdAt: now,
      expiresAt,
      maxBytes,
      allowedMimeTypes:
        opts.agentLimits?.allowed_mime_types && opts.agentLimits.allowed_mime_types.length > 0
          ? opts.agentLimits.allowed_mime_types
          : this.config.allowed_mime_types,
      explicitFilename: Boolean(opts.filename?.trim()),
      explicitContentType: Boolean(
        normalizedProvided && normalizedProvided !== 'application/octet-stream'
      ),
      inFlightRefs: 0,
    };

    this.uploads.set(id, record);
    this.uploadTokens.set(sha256Hex(uploadToken), id);

    const uploadPath = `/uploads/${uploadToken}`;
    const uploadUrl = `${this.getPublicBaseUrl({
      agentPublicUrl: opts.agentLimits?.public_url,
      requestHost: opts.requestHost,
    })}${uploadPath}`;

    return {
      uploadId: id,
      ref: formatUploadRef(id),
      uploadToken,
      uploadPath,
      uploadUrl,
      method: 'PUT',
      filename,
      contentType,
      expiresAt: new Date(expiresAt).toISOString(),
      maxBytes,
    };
  }

  async completePresignedUpload(
    rawToken: string,
    input: {
      stream: Readable;
      contentTypeHeader?: string;
      contentLength?: number;
    }
  ): Promise<CompletedUploadInfo> {
    if (!this.config.enabled) {
      throw new UploadHttpError(404, 'File uploads are disabled.');
    }
    this.sweepExpired();

    const tokenHash = sha256Hex(rawToken);
    const uploadId = this.uploadTokens.get(tokenHash);
    if (!uploadId) {
      throw new UploadHttpError(404, 'Upload URL is invalid, expired, or already used.');
    }

    const record = this.uploads.get(uploadId);
    if (!record) {
      this.uploadTokens.delete(tokenHash);
      throw new UploadHttpError(404, 'Upload URL is invalid, expired, or already used.');
    }

    if (record.expiresAt <= Date.now()) {
      this.uploadTokens.delete(tokenHash);
      this.uploads.delete(uploadId);
      throw new UploadHttpError(410, 'Upload URL has expired.');
    }

    if (record.status !== 'pending') {
      throw new UploadHttpError(409, 'Upload has already been used.');
    }

    // Consume the one-time token atomically before any await so concurrent PUTs cannot race.
    this.uploadTokens.delete(tokenHash);
    record.status = 'uploading';

    try {
      return await this.receiveUploadStream(record, input);
    } catch (err) {
      if (this.uploads.get(record.id) === record) {
        this.uploads.delete(record.id);
      }
      await this.removeUploadDir(record.id);
      throw err;
    }
  }

  async createDirectUpload(
    agentId: string,
    input: {
      stream: Readable;
      filename?: string;
      contentTypeHeader?: string;
      contentLength?: number;
      agentLimits?: AgentUploadsConfig;
      sessionId?: string;
    }
  ): Promise<CompletedUploadInfo> {
    if (!this.config.enabled || input.agentLimits?.enabled === false) {
      throw new UploadHttpError(404, 'File uploads are disabled.');
    }
    this.sweepExpired();

    const maxBytes = effectiveMaxFileBytes(this.config, input.agentLimits);
    const maxFiles = effectiveMaxFiles(this.config, input.agentLimits);
    this.assertRecordQuota(agentId, maxFiles, input.sessionId, true);

    const id = `upl_${randomBytes(16).toString('base64url')}`;
    const filename = sanitizeFilename(input.filename);
    const isMultipart = isMultipartHeader(input.contentTypeHeader);
    const headerMime = isMultipart ? undefined : normalizeMimeType(input.contentTypeHeader);
    const contentType = inferMimeType(filename, headerMime);

    this.ensureDir();
    const record: StagedUploadRecord = {
      id,
      agentId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: 'uploading',
      filename,
      contentType,
      sizeBytes: 0,
      sha256: '',
      blockSize: STREAM_VERIFY_BLOCK_BYTES,
      blockDigests: Buffer.alloc(0),
      diskPath: this.safeDiskPath(id, filename),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.ttl_ms,
      maxBytes,
      allowedMimeTypes:
        input.agentLimits?.allowed_mime_types && input.agentLimits.allowed_mime_types.length > 0
          ? input.agentLimits.allowed_mime_types
          : this.config.allowed_mime_types,
      explicitFilename: Boolean(input.filename?.trim()),
      explicitContentType: Boolean(headerMime && headerMime !== 'application/octet-stream'),
      inFlightRefs: 0,
    };

    this.uploads.set(id, record);
    try {
      return await this.receiveUploadStream(record, {
        stream: input.stream,
        contentTypeHeader: input.contentTypeHeader,
        contentLength: input.contentLength,
      });
    } catch (err) {
      if (this.uploads.get(record.id) === record) {
        this.uploads.delete(record.id);
      }
      await this.removeUploadDir(record.id);
      throw err;
    }
  }

  getReadyUpload(
    agentId: string,
    uploadId: string,
    sessionId?: string
  ): StagedUploadRecord | undefined {
    const record = this.uploads.get(uploadId);
    if (!record || !this.ownsUpload(record, agentId, sessionId) || record.status !== 'ready') {
      return undefined;
    }
    if (record.inFlightRefs === 0 && record.expiresAt <= Date.now()) {
      this.deleteRecordSync(record.id);
      return undefined;
    }
    return record;
  }

  getUploadAnyStatus(
    agentId: string,
    uploadId: string,
    sessionId?: string
  ): StagedUploadRecord | undefined {
    const record = this.uploads.get(uploadId);
    if (!record || !this.ownsUpload(record, agentId, sessionId)) return undefined;
    // Never evict an actively streaming or pinned record mid-flight.
    if (
      record.status !== 'uploading' &&
      record.inFlightRefs === 0 &&
      record.expiresAt <= Date.now()
    ) {
      this.deleteRecordSync(record.id);
      return undefined;
    }
    return record;
  }

  deleteUpload(agentId: string, uploadId: string, sessionId?: string): boolean {
    const record = this.uploads.get(uploadId);
    if (!record || !this.ownsUpload(record, agentId, sessionId)) return false;
    if (record.status === 'uploading') {
      throw new Error(`Upload "${uploadId}" is currently uploading and cannot be deleted yet.`);
    }
    if (record.inFlightRefs > 0) {
      throw new Error(
        `Upload "${uploadId}" is currently in use by an active tool call or download.`
      );
    }
    this.deleteRecordSync(uploadId);
    return true;
  }

  /**
   * Pin one or more ready uploads for the duration of a tool call (including any HITL approval
   * wait) so TTL cleanup never evicts a file before execution completes.
   */
  pin(agentId: string, uploadIds: string[], sessionId?: string): () => void {
    const uniqueIds = Array.from(new Set(uploadIds));
    const pinned: StagedUploadRecord[] = [];
    for (const id of uniqueIds) {
      const rec = this.getReadyUpload(agentId, id, sessionId);
      if (rec) {
        rec.inFlightRefs += 1;
        pinned.push(rec);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const rec of pinned) {
        rec.inFlightRefs = Math.max(0, rec.inFlightRefs - 1);
      }
    };
  }

  /**
   * Read staged bytes from a verified non-symlink regular file descriptor and confirm the SHA-256
   * digest matches the staged record, tracking the pending read against concurrent revocation.
   */
  async readBytes(
    agentId: string,
    uploadId: string,
    sessionId?: string
  ): Promise<{ record: StagedUploadRecord; bytes: Buffer }> {
    if (!this.config.enabled) {
      throw new Error('File uploads are disabled.');
    }
    const record = this.getReadyUpload(agentId, uploadId, sessionId);
    if (!record) {
      throw new Error(`Upload "${uploadId}" not found, not yet uploaded, or expired.`);
    }

    let aborted = false;
    const { finish: finishFd } = this.registerActiveTransfer(agentId, record.sizeBytes, () => {
      aborted = true;
    });
    record.inFlightRefs += 1;

    let fh: FileHandle | undefined;
    try {
      fh = await this.openVerifiedFile(record);
      if (aborted || !this.config.enabled || this.uploads.get(record.id) !== record) {
        throw new Error(`Upload "${uploadId}" is no longer available.`);
      }
      const bytes = await fh.readFile();
      await fh.close().catch(() => {});
      fh = undefined;
      if (aborted || !this.config.enabled || this.uploads.get(record.id) !== record) {
        throw new Error(`Upload "${uploadId}" is no longer available.`);
      }
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== record.sha256) {
        throw new Error(`Staged upload "${uploadId}" failed SHA-256 integrity verification.`);
      }
      return { record, bytes };
    } finally {
      if (fh) await fh.close().catch(() => {});
      record.inFlightRefs = Math.max(0, record.inFlightRefs - 1);
      finishFd();
    }
  }

  /**
   * Open a verified non-symlink file descriptor as a digest-verifying Web ReadableStream for
   * zero-buffer raw binary HTTP/OpenAPI delivery. Tracks the transfer across the async open and
   * pins the record until the descriptor closes.
   */
  async openVerifiedStream(
    agentId: string,
    uploadId: string,
    sessionId?: string
  ): Promise<{
    record: StagedUploadRecord;
    stream: ReadableStream<Uint8Array>;
    close: () => void;
  }> {
    if (!this.config.enabled) {
      throw new Error('File uploads are disabled.');
    }
    const record = this.getReadyUpload(agentId, uploadId, sessionId);
    if (!record) {
      throw new Error(`Upload "${uploadId}" not found, not yet uploaded, or expired.`);
    }

    let aborted = false;
    const streamRef: { current?: Readable } = {};
    const { finish: finishFd } = this.registerActiveTransfer(agentId, record.sizeBytes, () => {
      aborted = true;
      if (streamRef.current && !streamRef.current.destroyed) {
        streamRef.current.destroy(new Error('Staged file uploads were disabled.'));
      }
    });
    record.inFlightRefs += 1;

    let fh: FileHandle;
    try {
      fh = await this.openVerifiedFile(record);
    } catch (err) {
      record.inFlightRefs = Math.max(0, record.inFlightRefs - 1);
      finishFd();
      throw err;
    }

    if (aborted || !this.config.enabled || this.uploads.get(record.id) !== record) {
      record.inFlightRefs = Math.max(0, record.inFlightRefs - 1);
      await fh.close().catch(() => {});
      finishFd();
      throw new Error(`Upload "${uploadId}" is no longer available.`);
    }

    const nodeStream = createDigestVerifyingStream(
      fh,
      record,
      () => {
        record.inFlightRefs = Math.max(0, record.inFlightRefs - 1);
      },
      finishFd
    );
    streamRef.current = nodeStream;
    return {
      record,
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      close: () => {
        if (!nodeStream.destroyed && !nodeStream.readableEnded) nodeStream.destroy();
      },
    };
  }

  /**
   * Stream a `multipart/form-data` request directly from verified, already-open `O_NOFOLLOW` file
   * descriptors without path reopens or RAM buffering, verifying each file's exact size and
   * SHA-256 digest during transmission and tracking pending opens/transfers until every descriptor
   * closes.
   */
  async openStreamingMultipart(
    agentId: string,
    parts: MultipartFieldSpec[],
    sessionId?: string
  ): Promise<StreamingMultipartBody> {
    if (!this.config.enabled) {
      throw new Error('File uploads are disabled.');
    }
    type PreparedPart =
      | { kind: 'text'; header: Buffer; body: Buffer }
      | { kind: 'upload'; header: Buffer; record: StagedUploadRecord; fh: FileHandle };

    const boundary = `----AirlockBoundary${randomBytes(16).toString('hex')}`;
    const prepared: PreparedPart[] = [];
    const openedHandles: FileHandle[] = [];
    const pinnedRecords: StagedUploadRecord[] = [];
    let aborted = false;
    let activePartStream: Readable | undefined;
    const nodeStreamRef: { current?: Readable } = {};
    let cleaned = false;

    const { entry: transferEntry, finish: finishFd } = this.registerActiveTransfer(
      agentId,
      0,
      () => {
        aborted = true;
        if (activePartStream && !activePartStream.destroyed) {
          activePartStream.destroy(new Error('Staged file uploads were disabled.'));
        }
        if (nodeStreamRef.current && !nodeStreamRef.current.destroyed) {
          nodeStreamRef.current.destroy(new Error('Staged file uploads were disabled.'));
        }
      }
    );

    const releaseAll = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      for (const rec of pinnedRecords) {
        rec.inFlightRefs = Math.max(0, rec.inFlightRefs - 1);
      }
      await Promise.allSettled(openedHandles.map((fh) => fh.close()));
      finishFd();
    };

    try {
      for (const part of parts) {
        if (aborted || !this.config.enabled) {
          throw new Error('File uploads were disabled before transfer started.');
        }
        if (part.kind === 'text') {
          const header = Buffer.from(
            `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="${escapeMultipartParam(part.name)}"\r\n\r\n`,
            'utf8'
          );
          const body = Buffer.from(part.value, 'utf8');
          prepared.push({ kind: 'text', header, body });
        } else {
          const record = this.getReadyUpload(agentId, part.uploadId, sessionId);
          if (!record) {
            throw new Error(`Upload "${part.uploadId}" not found, not yet uploaded, or expired.`);
          }
          // Account and pin BEFORE awaiting open so concurrent disable/revoke tracks this handle.
          transferEntry.bytes += record.sizeBytes;
          record.inFlightRefs += 1;
          pinnedRecords.push(record);

          const fh = await this.openVerifiedFile(record);
          openedHandles.push(fh);
          if (aborted || !this.config.enabled || this.uploads.get(record.id) !== record) {
            throw new Error(`Upload "${part.uploadId}" is no longer available.`);
          }

          const header = Buffer.from(
            `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="${escapeMultipartParam(part.name)}"; filename="${escapeMultipartParam(record.filename)}"\r\n` +
              `Content-Type: ${record.contentType}\r\n\r\n`,
            'utf8'
          );
          prepared.push({ kind: 'upload', header, record, fh });
        }
      }
      if (aborted || !this.config.enabled) {
        throw new Error('File uploads were disabled before transfer started.');
      }
    } catch (err) {
      await releaseAll();
      throw err;
    }

    const crlf = Buffer.from('\r\n');
    const closing = Buffer.from(`--${boundary}--\r\n`, 'utf8');
    let contentLength = closing.byteLength;
    for (const part of prepared) {
      contentLength +=
        part.header.byteLength +
        (part.kind === 'text' ? part.body.byteLength : part.record.sizeBytes) +
        crlf.byteLength;
    }

    const cleanup = () => {
      void releaseAll();
    };

    async function* generate(): AsyncGenerator<Buffer> {
      try {
        for (const part of prepared) {
          yield part.header;
          if (part.kind === 'text') {
            if (part.body.byteLength > 0) yield part.body;
          } else {
            const verifiedStream = createDigestVerifyingStream(part.fh, part.record);
            activePartStream = verifiedStream;
            try {
              for await (const chunk of verifiedStream) {
                yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
              }
            } finally {
              activePartStream = undefined;
            }
          }
          yield crlf;
        }
        yield closing;
      } finally {
        cleanup();
      }
    }

    const nodeStream = Readable.from(generate());
    nodeStreamRef.current = nodeStream;
    nodeStream.once('close', cleanup);
    nodeStream.once('error', cleanup);

    return {
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      contentType: `multipart/form-data; boundary=${boundary}`,
      contentLength,
      close: () => {
        if (!nodeStream.destroyed && !nodeStream.readableEnded) nodeStream.destroy();
        cleanup();
      },
    };
  }

  resolveDiskPath(
    agentId: string,
    uploadId: string,
    pathPrefix?: string,
    sessionId?: string
  ): { record: StagedUploadRecord; diskPath: string } {
    const record = this.getReadyUpload(agentId, uploadId, sessionId);
    if (!record) {
      throw new Error(`Upload "${uploadId}" not found, not yet uploaded, or expired.`);
    }
    this.assertContainedPath(record.diskPath);
    if (pathPrefix) {
      const trimmed = pathPrefix.replace(/\/+$/, '');
      return { record, diskPath: `${trimmed}/${record.id}/${record.filename}` };
    }
    return { record, diskPath: record.diskPath };
  }

  mintDownloadUrl(
    agentId: string,
    uploadId: string,
    sessionId?: string
  ): {
    record: StagedUploadRecord;
    downloadToken: string;
    downloadUrl: string;
    downloadPath: string;
    expiresAt: string;
  } {
    const record = this.getReadyUpload(agentId, uploadId, sessionId);
    if (!record) {
      throw new Error(`Upload "${uploadId}" not found, not yet uploaded, or expired.`);
    }
    const token = `dl_${randomBytes(32).toString('base64url')}`;
    const expiresAt = Date.now() + this.config.download_ttl_ms;
    const MAX_DOWNLOAD_TOKENS = 10_000;
    if (this.downloadTokens.size >= MAX_DOWNLOAD_TOKENS) {
      const now = Date.now();
      for (const [k, ticket] of this.downloadTokens) {
        if (ticket.expiresAt <= now) this.downloadTokens.delete(k);
      }
      if (this.downloadTokens.size >= MAX_DOWNLOAD_TOKENS) {
        const oldest = this.downloadTokens.keys().next().value;
        if (oldest !== undefined) this.downloadTokens.delete(oldest);
      }
    }
    this.downloadTokens.set(sha256Hex(token), {
      uploadId: record.id,
      agentId,
      ...(sessionId ? { sessionId } : {}),
      expiresAt,
    });
    const downloadPath = `/uploads/dl/${token}`;
    const downloadUrl = `${this.getInternalBaseUrl()}${downloadPath}`;
    return {
      record,
      downloadToken: token,
      downloadUrl,
      downloadPath,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  revokeDownloadToken(rawToken: string): void {
    this.downloadTokens.delete(sha256Hex(rawToken));
  }

  async openDownload(
    rawToken: string,
    consume: boolean
  ): Promise<{ record: StagedUploadRecord; stream?: Readable } | undefined> {
    if (!this.config.enabled) return undefined;
    const tokenHash = sha256Hex(rawToken);
    const ticket = this.downloadTokens.get(tokenHash);
    if (!ticket) return undefined;
    if (ticket.expiresAt <= Date.now()) {
      this.downloadTokens.delete(tokenHash);
      return undefined;
    }
    const record = this.getReadyUpload(ticket.agentId, ticket.uploadId, ticket.sessionId);
    if (!record) {
      this.downloadTokens.delete(tokenHash);
      return undefined;
    }

    let aborted = false;
    const streamRef: { current?: Readable } = {};
    const { finish: finishFd } = this.registerActiveTransfer(
      ticket.agentId,
      record.sizeBytes,
      () => {
        aborted = true;
        if (streamRef.current && !streamRef.current.destroyed) {
          streamRef.current.destroy(new Error('Staged file uploads were disabled.'));
        }
      }
    );
    record.inFlightRefs += 1;

    let fh: FileHandle;
    try {
      fh = await this.openVerifiedFile(record);
    } catch {
      record.inFlightRefs = Math.max(0, record.inFlightRefs - 1);
      finishFd();
      this.downloadTokens.delete(tokenHash);
      return undefined;
    }

    // Re-check store state, record ownership, and ticket atomically after async open so concurrent
    // disable/revocation or a racing GET can never stream an invalid or unlinked descriptor.
    if (
      aborted ||
      !this.config.enabled ||
      this.uploads.get(record.id) !== record ||
      !this.downloadTokens.has(tokenHash)
    ) {
      record.inFlightRefs = Math.max(0, record.inFlightRefs - 1);
      await fh.close().catch(() => {});
      finishFd();
      return undefined;
    }

    if (!consume) {
      record.inFlightRefs = Math.max(0, record.inFlightRefs - 1);
      await fh.close().catch(() => {});
      finishFd();
      return { record };
    }

    this.downloadTokens.delete(tokenHash);
    const stream = createDigestVerifyingStream(
      fh,
      record,
      () => {
        record.inFlightRefs = Math.max(0, record.inFlightRefs - 1);
      },
      finishFd
    );
    streamRef.current = stream;
    return { record, stream };
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const [tokenHash, uploadId] of this.uploadTokens.entries()) {
      const rec = this.uploads.get(uploadId);
      if (!rec || rec.status !== 'pending' || rec.expiresAt <= now) {
        this.uploadTokens.delete(tokenHash);
      }
    }
    for (const [tokenHash, ticket] of this.downloadTokens.entries()) {
      if (ticket.expiresAt <= now || !this.uploads.has(ticket.uploadId)) {
        this.downloadTokens.delete(tokenHash);
      }
    }
    for (const [id, rec] of this.uploads.entries()) {
      if (rec.status === 'uploading' || rec.inFlightRefs > 0) continue;
      if (rec.expiresAt <= now) {
        this.deleteRecordSync(id);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopSweeper();
    this.clearAllSync();
    await Promise.resolve();
  }

  private assertEnabled(agentLimits?: AgentUploadsConfig): void {
    if (!this.config.enabled || agentLimits?.enabled === false) {
      throw new Error('File uploads are disabled.');
    }
  }

  private ownsUpload(record: StagedUploadRecord, agentId: string, sessionId?: string): boolean {
    return record.agentId === agentId && record.sessionId === sessionId;
  }

  private countAgentUploads(agentId: string, sessionId?: string): number {
    let count = 0;
    for (const rec of this.uploads.values()) {
      if (this.ownsUpload(rec, agentId, sessionId)) count += 1;
    }
    return count;
  }

  private countAllAgentUploads(agentId: string): number {
    let count = 0;
    for (const rec of this.uploads.values()) {
      if (rec.agentId === agentId) count += 1;
    }
    return count;
  }

  private assertRecordQuota(
    agentId: string,
    maxFiles: number,
    sessionId: string | undefined,
    httpError: boolean
  ): void {
    const fail = (message: string): never => {
      if (httpError) throw new UploadHttpError(429, message);
      throw new Error(message);
    };

    const globalCap = Math.max(MIN_GLOBAL_RECORD_CAP, this.config.max_files_per_agent * 20);
    if (this.uploads.size >= globalCap) {
      fail(
        `Gateway active staged upload record cap reached (${globalCap}). Delete unused uploads or wait for expiry.`
      );
    }

    const activeInScope = this.countAgentUploads(agentId, sessionId);
    if (activeInScope >= maxFiles) {
      fail(
        `Agent "${agentId}" already has ${activeInScope} active staged upload(s) (limit: ${maxFiles}). Delete an unused upload or wait for expiry.`
      );
    }

    // Always bound total active records per agent across both sessioned and sessionless callers.
    const aggregateCap = maxFiles * SESSION_AGENT_RECORD_MULTIPLIER;
    const totalForAgent = this.countAllAgentUploads(agentId);
    if (totalForAgent >= aggregateCap) {
      fail(
        `Agent "${agentId}" already has ${totalForAgent} active staged upload(s) across all sessions (limit: ${aggregateCap}). Delete unused uploads or wait for expiry.`
      );
    }
  }

  private totalStoredBytes(): number {
    let total = this.drainingTransferBytes;
    for (const rec of this.uploads.values()) {
      if (rec.status === 'ready') total += rec.sizeBytes;
    }
    return total;
  }

  private registerActiveTransfer(
    agentId: string,
    bytes: number,
    abort: () => void
  ): { entry: ActiveTransfer; finish: () => void } {
    const entry: ActiveTransfer = { agentId, bytes, draining: false, abort };
    this.activeTransfers.add(entry);
    let finished = false;
    return {
      entry,
      finish: () => {
        if (finished) return;
        finished = true;
        this.activeTransfers.delete(entry);
        if (entry.draining) {
          entry.draining = false;
          this.drainingTransferBytes = Math.max(0, this.drainingTransferBytes - entry.bytes);
        }
      },
    };
  }

  private tryReserveBytes(delta: number): boolean {
    if (delta <= 0) return true;
    if (
      this.totalStoredBytes() + this.inFlightReservedBytes + delta >
      this.config.max_total_bytes
    ) {
      return false;
    }
    this.inFlightReservedBytes += delta;
    return true;
  }

  private releaseReservedBytes(delta: number): void {
    if (delta <= 0) return;
    this.inFlightReservedBytes = Math.max(0, this.inFlightReservedBytes - delta);
  }

  private ownerLeasePath(): string {
    return join(this.resolvedDir, OWNER_LOCK_FILENAME);
  }

  private acquireOwnerLockOrThrow(): void {
    if (ACTIVE_OWNED_DIRS.has(this.canonicalDir)) {
      throw new Error(
        `Upload staging directory "${this.resolvedDir}" is already owned by another active Airlock instance in this process. Configure a separate uploads.dir or omit uploads.dir for an isolated temporary directory.`
      );
    }

    // Acquire an OS-kernel-enforced exclusive lock for the entire ownership lifetime via SQLite's
    // EXCLUSIVE locking mode (POSIX fcntl F_WRLCK / Windows LockFileEx). The kernel guarantees at
    // most one process/container owns the staging directory concurrently and releases the lock
    // automatically on process exit or crash (SIGKILL/OOM).
    const lockPath = this.ownerLeasePath();
    let db: Database.Database | undefined;
    try {
      // Short busy timeout (50ms) resolves transient simultaneous-startup SHARED-lock collisions
      // deterministically (exactly one starter wins), while still failing promptly against any
      // live owner holding the permanent EXCLUSIVE lock.
      db = new Database(lockPath, { timeout: 50 });
      db.pragma('locking_mode = EXCLUSIVE');
      // Acquire the permanent EXCLUSIVE lock and check whether a shutting-down temp-dir owner
      // already retired this lock inode before unlinking it. Checking on the same SQLite handle
      // avoids opening/closing a second descriptor (which would drop POSIX fcntl locks).
      db.exec(
        'BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock_v2 (id INTEGER PRIMARY KEY, pid INTEGER, retired INTEGER NOT NULL DEFAULT 0);'
      );
      const existing = db.prepare('SELECT retired FROM owner_lock_v2 WHERE id = 1').get() as
        | { retired?: number }
        | undefined;
      if (existing?.retired === 1) {
        db.exec('ROLLBACK;');
        const staleErr = new Error('Ownership lock file was retired during directory teardown.');
        (staleErr as Error & { code?: string }).code = 'SQLITE_BUSY';
        throw staleErr;
      }
      db.prepare('INSERT OR REPLACE INTO owner_lock_v2 (id, pid, retired) VALUES (1, ?, 0)').run(
        process.pid
      );
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db?.close();
      } catch {
        // Ignore close error on failed lock
      }
      const code = (err as { code?: string }).code ?? '';
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
        throw new Error(
          `Upload staging directory "${this.resolvedDir}" is already owned by another active Airlock instance. Configure a separate uploads.dir or omit uploads.dir for an isolated temporary directory.`,
          { cause: err }
        );
      }
      throw new Error(
        `Failed to acquire exclusive ownership lock on upload staging directory "${this.resolvedDir}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    this.ownerLockDb = db;
    ACTIVE_OWNED_DIRS.add(this.canonicalDir);
  }

  private releaseOwnerLease(): void {
    if (this.canonicalDir) {
      ACTIVE_OWNED_DIRS.delete(this.canonicalDir);
    }
    if (!this.ownerLockDb) return;
    const db = this.ownerLockDb;
    this.ownerLockDb = undefined;
    try {
      db.close();
    } catch {
      // Best-effort release
    }
  }

  private ensureDir(): void {
    if (this.dirReady) return;
    if (this.ownedTempDir) {
      // Every store without an explicit uploads.dir gets its own unique temp directory AND acquires
      // the same OS-enforced exclusive lock so another process explicitly targeting this path
      // cannot claim ownership or sweep live files.
      this.resolvedDir = resolve(mkdtempSync(join(tmpdir(), 'airlock-uploads-')));
      this.canonicalDir = realpathSync(this.resolvedDir);
      this.acquireOwnerLockOrThrow();
    } else {
      mkdirSync(this.resolvedDir, { recursive: true, mode: 0o700 });
      this.canonicalDir = realpathSync(this.resolvedDir);
      // Require OS-enforced exclusive directory ownership before accepting uploads or reaping orphans.
      this.acquireOwnerLockOrThrow();
      this.cleanupOrphanedEntriesFromDeadOwner();
    }
    this.dirReady = true;
  }

  private cleanupOrphanedEntriesFromDeadOwner(): void {
    try {
      const entries = readdirSync(this.resolvedDir);
      for (const name of entries) {
        const isManaged =
          (UPLOAD_ID_PATTERN.test(name) && !this.uploads.has(name)) || name.startsWith('.tmp-');
        if (!isManaged) continue;
        const fullPath = join(this.resolvedDir, name);
        try {
          lstatSync(fullPath);
          rmSync(fullPath, { recursive: true, force: true });
        } catch {
          // Entry disappeared concurrently
        }
      }
    } catch (err) {
      log.warn({ err, dir: this.resolvedDir }, 'Failed to sweep orphaned upload staging entries');
    }
  }

  private startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private stopSweeper(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private safeDiskPath(uploadId: string, filename: string): string {
    const expectedDir = resolve(this.resolvedDir, uploadId);
    const filePath = resolve(expectedDir, filename);
    this.assertContainedPath(filePath);
    if (dirname(filePath) !== expectedDir) {
      throw new UploadHttpError(400, 'Invalid upload filename.');
    }
    return filePath;
  }

  private assertContainedPath(filePath: string): void {
    const resolved = resolve(filePath);
    if (!this.resolvedDir || !resolved.startsWith(this.resolvedDir + sep)) {
      throw new Error('Resolved upload path escaped staging directory.');
    }
  }

  private async openVerifiedFile(record: StagedUploadRecord): Promise<FileHandle> {
    this.assertContainedPath(record.diskPath);
    const parentDir = resolve(this.resolvedDir, record.id);
    const parentStat = await lstat(parentDir);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error(`Staged upload "${record.id}" directory failed integrity verification.`);
    }
    // Verify canonical parent path sits directly under canonical staging root (blocks ancestor symlinks).
    const canonicalParent = await realpath(dirname(record.diskPath));
    const expectedParent = join(this.canonicalDir || realpathSync(this.resolvedDir), record.id);
    if (canonicalParent !== expectedParent) {
      throw new Error(`Staged upload "${record.id}" parent path escaped staging root.`);
    }

    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const fh = await open(record.diskPath, flags);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size !== record.sizeBytes) {
        throw new Error(`Staged upload "${record.id}" failed size or file-type verification.`);
      }
      if (
        record.fileIdentity &&
        (st.dev !== record.fileIdentity.dev ||
          st.ino !== record.fileIdentity.ino ||
          st.mtimeMs !== record.fileIdentity.mtimeMs ||
          st.ctimeMs !== record.fileIdentity.ctimeMs)
      ) {
        throw new Error(`Staged upload "${record.id}" file metadata changed after staging.`);
      }
      return fh;
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
  }

  private deleteRecordSync(uploadId: string): void {
    this.uploads.delete(uploadId);
    for (const [tokenHash, id] of this.uploadTokens.entries()) {
      if (id === uploadId) this.uploadTokens.delete(tokenHash);
    }
    for (const [tokenHash, ticket] of this.downloadTokens.entries()) {
      if (ticket.uploadId === uploadId) this.downloadTokens.delete(tokenHash);
    }
    if (!this.resolvedDir) return;
    try {
      const dir = resolve(this.resolvedDir, uploadId);
      if (dir.startsWith(this.resolvedDir + sep)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      log.warn({ err, uploadId }, 'Failed to remove staged upload directory');
    }
  }

  private async removeUploadDir(uploadId: string): Promise<void> {
    if (!this.resolvedDir) return;
    try {
      const dir = resolve(this.resolvedDir, uploadId);
      if (dir.startsWith(this.resolvedDir + sep)) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (err) {
      log.warn({ err, uploadId }, 'Failed to clean up failed upload directory');
    }
  }

  private clearAllSync(): void {
    // Transfer any active download/delivery streams into draining byte accounting BEFORE deleting
    // records, and immediately abort them so open descriptors cannot outlive quota accounting.
    for (const transfer of Array.from(this.activeTransfers)) {
      if (!transfer.draining) {
        transfer.draining = true;
        this.drainingTransferBytes += transfer.bytes;
      }
      transfer.abort();
    }
    for (const id of Array.from(this.uploads.keys())) {
      this.deleteRecordSync(id);
    }
    this.uploadTokens.clear();
    this.downloadTokens.clear();
    if (this.ownedTempDir && this.dirReady && this.resolvedDir) {
      const dirToRemove = this.resolvedDir;
      const lockPath = this.ownerLeasePath();
      try {
        // Remove all staged child entries WHILE `.airlock-owner.lock` stays intact at its stable
        // pathname and exclusively locked by the OS kernel, so no second process can acquire
        // ownership or stage files while recursive child removal is running.
        for (const name of readdirSync(dirToRemove)) {
          if (name === OWNER_LOCK_FILENAME || name.startsWith(`${OWNER_LOCK_FILENAME}-`)) {
            continue;
          }
          rmSync(join(dirToRemove, name), { recursive: true, force: true });
        }
        // Mark this lock inode retired while still holding the EXCLUSIVE lock so any concurrent
        // process already waiting on this inode rejects acquisition after we release the handle.
        // Require confirmation: if the tombstone fails, abort teardown without unlinking.
        if (!this.ownerLockDb) {
          throw new Error(
            'Cannot tear down temporary upload directory without an active ownership lock.'
          );
        }
        this.ownerLockDb
          .prepare('INSERT OR REPLACE INTO owner_lock_v2 (id, pid, retired) VALUES (1, ?, 1)')
          .run(process.pid);
        // Switch journaling to MEMORY BEFORE unlinking `.airlock-owner.lock` so SQLite closes and
        // deletes its on-disk `-journal` sidecar while our lock still occupies its pathname, and
        // `db.close()` will never unlink a successor's journal file afterwards.
        this.ownerLockDb.pragma('journal_mode = MEMORY');
        for (const sidecar of [`${lockPath}-journal`, `${lockPath}-wal`, `${lockPath}-shm`]) {
          try {
            unlinkSync(sidecar);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw err;
            }
          }
        }
        if (process.platform === 'win32') {
          // On Windows, locked files cannot be unlinked while open; release first, then remove
          // only the lock file and attempt a non-recursive rmdir (which leaves any reclaimed dir intact).
          this.releaseOwnerLease();
          try {
            unlinkSync(lockPath);
          } catch {
            // Reclaimed or already gone
          }
          try {
            rmdirSync(dirToRemove);
          } catch {
            // Non-empty or already gone; never recursively wipe after releasing the lock
          }
        } else {
          // On POSIX, unlink ONLY `.airlock-owner.lock` LAST (after all children and sidecars are
          // gone), then attempt a non-recursive rmdir (fails harmlessly with ENOTEMPTY if another
          // process created anything), and finally close the SQLite handle.
          try {
            unlinkSync(lockPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw err;
            }
          }
          try {
            rmdirSync(dirToRemove);
          } catch {
            // Non-empty or already gone; never recursively remove after unlinking the lock
          }
          this.releaseOwnerLease();
        }
      } catch (err) {
        log.warn({ err, dir: dirToRemove }, 'Failed to remove temporary upload directory');
        this.releaseOwnerLease();
      }
      this.resolvedDir = '';
      this.canonicalDir = '';
      this.dirReady = false;
    } else {
      this.releaseOwnerLease();
    }
  }

  private async receiveUploadStream(
    record: StagedUploadRecord,
    input: {
      stream: Readable;
      contentTypeHeader?: string;
      contentLength?: number;
    }
  ): Promise<CompletedUploadInfo> {
    const isMultipart = isMultipartHeader(input.contentTypeHeader);
    const streamLimit = isMultipart ? record.maxBytes + MULTIPART_OVERHEAD_BYTES : record.maxBytes;

    if (
      input.contentLength !== undefined &&
      Number.isFinite(input.contentLength) &&
      input.contentLength > streamLimit
    ) {
      throw new UploadHttpError(
        413,
        `Upload exceeds maximum file size of ${record.maxBytes} bytes.`
      );
    }

    if (
      !isMultipart &&
      input.contentLength !== undefined &&
      Number.isFinite(input.contentLength) &&
      this.totalStoredBytes() + this.inFlightReservedBytes + input.contentLength >
        this.config.max_total_bytes
    ) {
      throw new UploadHttpError(
        507,
        `Upload exceeds gateway staged upload storage quota (${this.config.max_total_bytes} bytes).`
      );
    }

    let filename = record.filename;
    let contentType: string;
    let sizeBytes: number;
    let sha256: string;
    let blockSize: number;
    let blockDigests: Buffer;
    let reservedBytes = 0;

    const reserveChunk = (delta: number): boolean => {
      if (!this.tryReserveBytes(delta)) return false;
      reservedBytes += delta;
      return true;
    };

    // Register incoming PUT/POST stream so disabling uploads or revoking this agent immediately
    // cancels the transfer, deletes its temp file, and frees shared quota.
    const { finish: finishIngress } = this.registerActiveTransfer(record.agentId, 0, () => {
      if (!input.stream.destroyed) {
        input.stream.destroy(new UploadHttpError(409, 'Upload was cancelled before completion.'));
      }
    });

    const tmpPath = resolve(
      this.resolvedDir,
      `.tmp-${record.id}-${randomBytes(6).toString('hex')}`
    );

    try {
      if (isMultipart) {
        const result = await streamMultipartFileToDisk(
          input.stream,
          input.contentTypeHeader!,
          tmpPath,
          record.maxBytes,
          this.config.max_total_bytes,
          this.streamIdleTimeoutMs,
          reserveChunk
        );
        sizeBytes = result.sizeBytes;
        sha256 = result.sha256;
        blockSize = result.blockSize;
        blockDigests = result.blockDigests;

        if (!record.explicitFilename && result.filename) {
          filename = sanitizeFilename(result.filename);
        }
        const extractedMime = normalizeMimeType(result.contentType);
        if (
          !record.explicitContentType &&
          extractedMime &&
          extractedMime !== 'application/octet-stream'
        ) {
          contentType = extractedMime;
        } else {
          contentType = inferMimeType(
            filename,
            record.explicitContentType ? record.contentType : extractedMime
          );
        }

        if (
          !matchesMimeAllowlist(contentType, this.config.allowed_mime_types) ||
          !matchesMimeAllowlist(contentType, record.allowedMimeTypes)
        ) {
          throw new UploadHttpError(415, `MIME type "${contentType}" is not allowed for uploads.`);
        }
      } else {
        const headerMime = normalizeMimeType(input.contentTypeHeader);
        if (
          !record.explicitContentType &&
          headerMime &&
          headerMime !== 'application/octet-stream'
        ) {
          contentType = headerMime;
        } else {
          contentType = inferMimeType(
            filename,
            record.explicitContentType ? record.contentType : headerMime
          );
        }
        if (
          !matchesMimeAllowlist(contentType, this.config.allowed_mime_types) ||
          !matchesMimeAllowlist(contentType, record.allowedMimeTypes)
        ) {
          throw new UploadHttpError(415, `MIME type "${contentType}" is not allowed for uploads.`);
        }

        const result = await streamToFileWithHash(
          input.stream,
          tmpPath,
          record.maxBytes,
          this.config.max_total_bytes,
          this.streamIdleTimeoutMs,
          reserveChunk
        );
        sizeBytes = result.sizeBytes;
        sha256 = result.sha256;
        blockSize = result.blockSize;
        blockDigests = result.blockDigests;
      }

      // Confirm this upload still belongs to the live store before publishing on disk.
      if (!this.config.enabled || this.uploads.get(record.id) !== record) {
        throw new UploadHttpError(409, 'Upload was cancelled before completion.');
      }

      const finalPath = this.safeDiskPath(record.id, filename);
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o755 });
      if (!this.config.enabled || this.uploads.get(record.id) !== record) {
        await this.removeUploadDir(record.id);
        throw new UploadHttpError(409, 'Upload was cancelled before completion.');
      }
      await rename(tmpPath, finalPath);
      const committedStat = await stat(finalPath);

      // Re-verify store state and record ownership AFTER rename/stat and before publishing ready so
      // revocation during commit never returns success for a detached record or leaves an orphan.
      if (!this.config.enabled || this.uploads.get(record.id) !== record) {
        await this.removeUploadDir(record.id);
        throw new UploadHttpError(409, 'Upload was cancelled before completion.');
      }

      // Transfer reserved bytes atomically to the ready record (no await between these lines).
      record.filename = filename;
      record.contentType = contentType;
      record.sizeBytes = sizeBytes;
      record.sha256 = sha256;
      record.blockSize = blockSize;
      record.blockDigests = blockDigests;
      record.diskPath = finalPath;
      record.fileIdentity = {
        dev: committedStat.dev,
        ino: committedStat.ino,
        mtimeMs: committedStat.mtimeMs,
        ctimeMs: committedStat.ctimeMs,
      };
      record.expiresAt = Date.now() + this.config.ttl_ms;
      record.status = 'ready';
      this.releaseReservedBytes(reservedBytes);
      reservedBytes = 0;

      return {
        upload_id: record.id,
        ref: formatUploadRef(record.id),
        filename: record.filename,
        content_type: record.contentType,
        size_bytes: record.sizeBytes,
        sha256: record.sha256,
        expires_at: new Date(record.expiresAt).toISOString(),
      };
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      if (!this.config.enabled || this.uploads.get(record.id) !== record) {
        await this.removeUploadDir(record.id);
        if (err instanceof UploadHttpError) throw err;
        throw new UploadHttpError(409, 'Upload was cancelled before completion.', { cause: err });
      }
      throw err;
    } finally {
      finishIngress();
      if (reservedBytes > 0) {
        this.releaseReservedBytes(reservedBytes);
      }
    }
  }
}

function isMultipartHeader(header?: string): boolean {
  return typeof header === 'string' && header.toLowerCase().startsWith('multipart/form-data');
}

function parseMultipartBoundary(header?: string): string | undefined {
  if (!header) return undefined;
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(header);
  const boundary = match?.[1] ?? match?.[2];
  return boundary && boundary.length > 0 && boundary.length <= 200 ? boundary : undefined;
}

function parsePartHeaders(headerBlock: string): {
  name?: string;
  filename?: string;
  contentType?: string;
} {
  let name: string | undefined;
  let filename: string | undefined;
  let contentType: string | undefined;

  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (key === 'content-disposition') {
      const nameMatch = /;\s*name="([^"]*)"/i.exec(val) ?? /;\s*name=([^;\s]+)/i.exec(val);
      if (nameMatch) name = nameMatch[1];
      const extFilenameMatch = /;\s*filename\*=(?:utf-8''|UTF-8'')([^;\s]+)/i.exec(val);
      if (extFilenameMatch) {
        try {
          filename = decodeURIComponent(extFilenameMatch[1]);
        } catch {
          filename = extFilenameMatch[1];
        }
      } else {
        const filenameMatch =
          /;\s*filename="([^"]*)"/i.exec(val) ?? /;\s*filename=([^;\s]+)/i.exec(val);
        if (filenameMatch) filename = filenameMatch[1];
      }
    } else if (key === 'content-type') {
      contentType = val;
    }
  }
  return { name, filename, contentType };
}

function attachIdleTimeout(
  stream: Readable,
  timeoutMs: number
): {
  touch: () => void;
  clear: () => void;
} {
  if (!timeoutMs || timeoutMs <= 0) {
    return { touch: () => {}, clear: () => {} };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stream.destroy(
        new UploadHttpError(408, `Upload stalled with no data received for ${timeoutMs}ms.`)
      );
    }, timeoutMs);
    timer.unref?.();
  };
  reset();
  return {
    touch: reset,
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

async function writeStreamChunk(ws: WriteStream, buf: Buffer): Promise<void> {
  if (buf.byteLength === 0) return;
  if (!ws.write(buf)) {
    await new Promise<void>((resolveDrain, rejectDrain) => {
      const onDrain = () => {
        ws.off('error', onError);
        resolveDrain();
      };
      const onError = (err: Error) => {
        ws.off('drain', onDrain);
        rejectDrain(err);
      };
      ws.once('drain', onDrain);
      ws.once('error', onError);
    });
  }
}

async function finishWriteStream(ws: WriteStream, existingError?: Error): Promise<void> {
  await new Promise<void>((resolveEnd, rejectEnd) => {
    if (existingError) {
      rejectEnd(existingError);
      return;
    }
    const onFinish = () => {
      ws.off('error', onError);
      resolveEnd();
    };
    const onError = (err: Error) => {
      ws.off('finish', onFinish);
      rejectEnd(err);
    };
    ws.once('finish', onFinish);
    ws.once('error', onError);
    ws.end();
  });
}

async function streamToFileWithHash(
  stream: Readable,
  destPath: string,
  maxFileBytes: number,
  maxTotalBytes: number,
  idleTimeoutMs: number,
  reserveChunk: (delta: number) => boolean
): Promise<{ sizeBytes: number; sha256: string; blockSize: number; blockDigests: Buffer }> {
  const digest = new ChunkedDigestBuilder();
  const ws = createWriteStream(destPath, { mode: 0o644 });
  let sizeBytes = 0;

  let wsError: Error | undefined;
  ws.once('error', (err) => {
    wsError = err;
  });

  const idle = attachIdleTimeout(stream, idleTimeoutMs);
  try {
    for await (const chunk of stream) {
      idle.touch();
      if (wsError) throw wsError;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      sizeBytes += buf.byteLength;
      if (sizeBytes > maxFileBytes) {
        stream.destroy();
        throw new UploadHttpError(
          413,
          `Upload exceeds maximum file size of ${maxFileBytes} bytes.`
        );
      }
      if (!reserveChunk(buf.byteLength)) {
        stream.destroy();
        throw new UploadHttpError(
          507,
          `Upload exceeds gateway staged upload storage quota (${maxTotalBytes} bytes).`
        );
      }
      digest.update(buf);
      await writeStreamChunk(ws, buf);
    }

    await finishWriteStream(ws, wsError);
    return { sizeBytes, ...digest.finish() };
  } catch (err) {
    ws.destroy();
    throw err;
  } finally {
    idle.clear();
  }
}

/**
 * Stream the first file part of a `multipart/form-data` request directly to disk while hashing and
 * enforcing both per-file and live gateway storage budgets without buffering the file in memory.
 */
async function streamMultipartFileToDisk(
  stream: Readable,
  contentTypeHeader: string,
  destPath: string,
  maxFileBytes: number,
  maxTotalBytes: number,
  idleTimeoutMs: number,
  reserveChunk: (delta: number) => boolean
): Promise<{
  sizeBytes: number;
  sha256: string;
  blockSize: number;
  blockDigests: Buffer;
  filename?: string;
  contentType?: string;
}> {
  const boundary = parseMultipartBoundary(contentTypeHeader);
  if (!boundary) {
    throw new UploadHttpError(400, 'Malformed multipart/form-data upload body (missing boundary).');
  }

  const firstBoundary = Buffer.from(`--${boundary}`);
  const closingMarker = Buffer.from(`\r\n--${boundary}`);
  const headerTerminator = Buffer.from('\r\n\r\n');

  type State = 'preamble' | 'headers' | 'file-body' | 'skip-body' | 'done';
  let state: State = 'preamble';
  let carry: Buffer = Buffer.alloc(0);
  let overheadBytes = 0;

  let fileCaptured = false;
  let capturedFilename: string | undefined;
  let capturedContentType: string | undefined;
  let sizeBytes = 0;
  const digest = new ChunkedDigestBuilder();
  let ws: WriteStream | undefined;
  let wsError: Error | undefined;

  const accountOverhead = (bytes: number): void => {
    overheadBytes += bytes;
    if (overheadBytes > MULTIPART_OVERHEAD_BYTES) {
      stream.destroy();
      throw new UploadHttpError(
        413,
        `Multipart non-file form overhead exceeded ${MULTIPART_OVERHEAD_BYTES} bytes.`
      );
    }
  };

  const writeFileBytes = async (slice: Buffer): Promise<void> => {
    if (slice.byteLength === 0) return;
    if (wsError) throw wsError;
    sizeBytes += slice.byteLength;
    if (sizeBytes > maxFileBytes) {
      stream.destroy();
      throw new UploadHttpError(413, `Upload exceeds maximum file size of ${maxFileBytes} bytes.`);
    }
    if (!reserveChunk(slice.byteLength)) {
      stream.destroy();
      throw new UploadHttpError(
        507,
        `Upload exceeds gateway staged upload storage quota (${maxTotalBytes} bytes).`
      );
    }
    digest.update(slice);
    await writeStreamChunk(ws!, slice);
  };

  const idle = attachIdleTimeout(stream, idleTimeoutMs);
  try {
    for await (const rawChunk of stream) {
      idle.touch();
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      carry = carry.byteLength > 0 ? Buffer.concat([carry, chunk]) : chunk;

      let progress = true;
      while (progress) {
        progress = false;

        if (state === 'preamble') {
          const idx = carry.indexOf(firstBoundary);
          if (idx === -1) {
            const keep = firstBoundary.byteLength - 1;
            if (carry.byteLength > keep) {
              accountOverhead(carry.byteLength - keep);
              carry = carry.subarray(carry.byteLength - keep);
            }
            break;
          }
          if (carry.byteLength < idx + firstBoundary.byteLength + 2) {
            break;
          }
          accountOverhead(idx + firstBoundary.byteLength + 2);
          const after = idx + firstBoundary.byteLength;
          const b0 = carry[after];
          const b1 = carry[after + 1];
          if (b0 === 0x2d && b1 === 0x2d) {
            state = 'done';
            carry = carry.subarray(after + 2);
            break;
          }
          if (b0 === 0x0d && b1 === 0x0a) {
            carry = carry.subarray(after + 2);
            state = 'headers';
            progress = true;
            continue;
          }
          throw new UploadHttpError(400, 'Malformed multipart/form-data boundary.');
        }

        if (state === 'headers') {
          const idx = carry.indexOf(headerTerminator);
          if (idx === -1) {
            if (carry.byteLength > MULTIPART_OVERHEAD_BYTES) {
              accountOverhead(carry.byteLength);
            }
            break;
          }
          const headerText = carry.subarray(0, idx).toString('utf8');
          accountOverhead(idx + headerTerminator.byteLength);
          carry = carry.subarray(idx + headerTerminator.byteLength);

          const parsed = parsePartHeaders(headerText);
          if (!fileCaptured && parsed.filename !== undefined) {
            capturedFilename = parsed.filename || undefined;
            capturedContentType = parsed.contentType || undefined;
            ws = createWriteStream(destPath, { mode: 0o644 });
            ws.once('error', (err) => {
              wsError = err;
            });
            state = 'file-body';
          } else {
            state = 'skip-body';
          }
          progress = true;
          continue;
        }

        if (state === 'file-body') {
          const idx = carry.indexOf(closingMarker);
          if (idx !== -1) {
            const after = idx + closingMarker.byteLength;
            if (carry.byteLength < after + 2) {
              break;
            }
            const b0 = carry[after];
            const b1 = carry[after + 1];
            const isClosing = b0 === 0x2d && b1 === 0x2d;
            const isNextPart = b0 === 0x0d && b1 === 0x0a;
            if (isClosing || isNextPart) {
              await writeFileBytes(carry.subarray(0, idx));
              await finishWriteStream(ws!, wsError);
              ws = undefined;
              fileCaptured = true;
              carry = carry.subarray(after + 2);
              state = isClosing ? 'done' : 'headers';
              progress = true;
              continue;
            }
            // Marker text occurred inside file payload without valid boundary trailer.
            await writeFileBytes(carry.subarray(0, idx + 2));
            carry = carry.subarray(idx + 2);
            progress = true;
            continue;
          }

          const keep = closingMarker.byteLength + 1;
          if (carry.byteLength > keep) {
            await writeFileBytes(carry.subarray(0, carry.byteLength - keep));
            carry = carry.subarray(carry.byteLength - keep);
          }
          break;
        }

        if (state === 'skip-body') {
          const idx = carry.indexOf(closingMarker);
          if (idx !== -1) {
            const after = idx + closingMarker.byteLength;
            if (carry.byteLength < after + 2) {
              break;
            }
            const b0 = carry[after];
            const b1 = carry[after + 1];
            const isClosing = b0 === 0x2d && b1 === 0x2d;
            const isNextPart = b0 === 0x0d && b1 === 0x0a;
            if (isClosing || isNextPart) {
              accountOverhead(idx + closingMarker.byteLength + 2);
              carry = carry.subarray(after + 2);
              state = isClosing ? 'done' : 'headers';
              progress = true;
              continue;
            }
            accountOverhead(idx + 2);
            carry = carry.subarray(idx + 2);
            progress = true;
            continue;
          }
          const keep = closingMarker.byteLength + 1;
          if (carry.byteLength > keep) {
            accountOverhead(carry.byteLength - keep);
            carry = carry.subarray(carry.byteLength - keep);
          }
          break;
        }

        if (state === 'done') {
          if (carry.byteLength > 0) {
            accountOverhead(carry.byteLength);
            carry = Buffer.alloc(0);
          }
          break;
        }
      }
    }

    if (ws) {
      ws.destroy();
      ws = undefined;
    }
    if (state !== 'done') {
      if (state === 'preamble') {
        throw new UploadHttpError(400, 'Malformed multipart/form-data upload body.');
      }
      throw new UploadHttpError(
        400,
        'Truncated multipart/form-data upload body (missing closing boundary).'
      );
    }
    if (!fileCaptured) {
      throw new UploadHttpError(
        400,
        'Multipart upload contained no file part. Send a file field (e.g. -F "file=@path") or raw binary body (--data-binary @path).'
      );
    }

    return {
      sizeBytes,
      ...digest.finish(),
      filename: capturedFilename,
      contentType: capturedContentType,
    };
  } catch (err) {
    ws?.destroy();
    throw err;
  } finally {
    idle.clear();
  }
}
