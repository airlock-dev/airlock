import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentConfig } from '../config/schema.js';
import type { AllowlistEngine } from '../allowlist/engine.js';
import { AIRLOCK_DELETE_UPLOAD_TOOL, AIRLOCK_PREPARE_UPLOAD_TOOL } from '../airlock/tools.js';
import { evaluateArgPolicy, resolveArgPolicy } from '../middleware/core/arg-policy.js';
import {
  evaluateCommandPolicy,
  resolveToolCommandPolicy,
} from '../middleware/core/command-policy.js';
import { isValidSessionId, SESSION_HEADER } from '../transport/agent-server.js';
import {
  checkAgentBearerAuth,
  checkBearerAuth,
  checkOrigin,
  currentRequestSecurity,
  hasAgentCredential,
  type RequestSecurityOptions,
} from '../security/request.js';
import { childLogger } from '../util/logger.js';
import { inferMimeType, normalizeMimeType, sanitizeFilename, toWellFormedUnicode } from './refs.js';
import { UploadHttpError, type UploadStore } from './store.js';

const log = childLogger('uploads-api');

export interface UploadsApiOpts {
  uploadStore: UploadStore;
  getAgentConfig?: (agentId: string) => AgentConfig | undefined;
  allowlist?: AllowlistEngine;
  /** Map an agent-supplied session id to the opaque downstream session id for that agent. */
  resolveSessionId?: (agentId: string, explicitSessionId: string) => string;
  /** Register direct agent-authenticated `/agents/:agentId/uploads` routes. Defaults to true. */
  enableDirectRoutes?: boolean;
  secret?: string;
  authRequired?: boolean;
  allowedOrigins?: string[];
  getRequestSecurity?: () => RequestSecurityOptions;
}

function formatContentDisposition(filename: string): string {
  const safe = toWellFormedUnicode(filename);
  const asciiFallback = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'upload.bin';
  const encoded = encodeURIComponent(safe).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function checkDirectToolPolicies(
  agentConfig: AgentConfig,
  toolName: string,
  args: Record<string, unknown>,
  knownKeys?: ReadonlySet<string>
): string | undefined {
  const cmdPolicy = resolveToolCommandPolicy(agentConfig, toolName, toolName);
  if (cmdPolicy) {
    for (const [argName, rule] of Object.entries(cmdPolicy)) {
      if (knownKeys && !knownKeys.has(argName)) continue;
      const val = args[argName];
      if (typeof val !== 'string') {
        return `${argName} must be a string for ${toolName}.`;
      }
      const decision = evaluateCommandPolicy(val, rule);
      if (decision !== 'allow') {
        return decision === 'ask'
          ? `Direct HTTP upload route cannot satisfy command_policy approval for ${toolName}; use MCP instead.`
          : `Argument "${argName}" is not permitted by command_policy for ${toolName}.`;
      }
    }
  }
  const argPolicy = resolveArgPolicy(agentConfig, toolName);
  if (!knownKeys) {
    return evaluateArgPolicy(argPolicy, toolName, args);
  }
  const filteredPolicy: typeof argPolicy = {};
  for (const [argName, constraints] of Object.entries(argPolicy)) {
    const applicable = constraints.filter((constraint) => {
      const targetRoot = (constraint.path ?? argName).split('.')[0]?.replace(/\[\]$/, '');
      return Boolean(targetRoot && knownKeys.has(targetRoot));
    });
    if (applicable.length > 0) {
      filteredPolicy[argName] = applicable;
    }
  }
  return evaluateArgPolicy(filteredPolicy, toolName, args);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseContentLength(header: string | string[] | undefined): number | undefined {
  const raw = firstHeader(header);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function uploadsApiPlugin(app: FastifyInstance, opts: UploadsApiOpts): Promise<void> {
  const { uploadStore } = opts;

  // Stream upload payloads directly from request.raw so Fastify never buffers large binaries
  // into memory or rejects non-JSON content types (model/3mf, application/octet-stream, etc.).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    (_req: FastifyRequest, payload: unknown, done: (err: null, body: unknown) => void) => {
      done(null, payload);
    }
  );

  function checkAgentAuth(
    request: FastifyRequest,
    reply: FastifyReply,
    agentConfig: AgentConfig
  ): boolean {
    const requestSecurity = currentRequestSecurity(opts);
    if (!checkOrigin(request, reply, requestSecurity.allowedOrigins)) return false;

    if (hasAgentCredential(agentConfig)) {
      return checkAgentBearerAuth(request, reply, agentConfig);
    }
    return checkBearerAuth(request, reply, {
      secret: requestSecurity.secret,
      authRequired: requestSecurity.authRequired,
    });
  }

  function sendUploadError(reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof UploadHttpError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    log.warn({ err }, 'Upload request failed');
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'Upload failed' });
  }

  async function handlePresignedUpload(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<unknown> {
    if (!uploadStore.isEnabled()) {
      return reply.status(404).send({ error: 'Not found' });
    }
    const requestSecurity = currentRequestSecurity(opts);
    if (!checkOrigin(request, reply, requestSecurity.allowedOrigins)) return;

    const { token } = request.params as { token: string };
    // Streaming uploads (e.g. 256 MiB 3MF or multi-GB video) rely on per-chunk idle timeout in
    // UploadStore rather than a short fixed socket deadline.
    request.raw.setTimeout?.(0);
    reply.raw.setTimeout?.(0);
    try {
      const info = await uploadStore.completePresignedUpload(token, {
        stream: request.raw,
        contentTypeHeader: firstHeader(request.headers['content-type']),
        contentLength: parseContentLength(request.headers['content-length']),
      });
      return reply.status(201).send(info);
    } catch (err) {
      return sendUploadError(reply, err);
    }
  }

  app.put('/uploads/:token', handlePresignedUpload);
  app.post('/uploads/:token', handlePresignedUpload);

  async function handleDownload(
    request: FastifyRequest,
    reply: FastifyReply,
    consume: boolean
  ): Promise<unknown> {
    if (!uploadStore.isEnabled()) {
      return reply.status(404).send({ error: 'Not found' });
    }
    const { token } = request.params as { token: string };
    const opened = await uploadStore.openDownload(token, consume);
    if (!opened) {
      return reply
        .status(404)
        .send({ error: 'Download URL is invalid, expired, or already used.' });
    }

    const { record, stream } = opened;
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Type', record.contentType)
      .header('Content-Length', String(record.sizeBytes))
      .header('Content-Disposition', formatContentDisposition(record.filename));

    if (!consume || !stream) {
      return reply.status(200).send();
    }
    reply.raw.setTimeout?.(0);
    reply.raw.once('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    return reply.status(200).send(stream);
  }

  app.head('/uploads/dl/:token', (req, reply) => handleDownload(req, reply, false));
  app.get('/uploads/dl/:token', (req, reply) => handleDownload(req, reply, true));

  if (opts.enableDirectRoutes === false) {
    return;
  }

  if (!opts.allowlist || !opts.getAgentConfig) {
    throw new Error(
      'uploadsApiPlugin requires allowlist and getAgentConfig when enableDirectRoutes is enabled.'
    );
  }
  const allowlist = opts.allowlist;
  const getAgentConfig = opts.getAgentConfig;

  // Direct agent-authenticated upload endpoint for REST / scripted agents that already hold
  // their agent bearer token.
  app.post('/agents/:agentId/uploads', async (request, reply) => {
    if (!uploadStore.isEnabled()) {
      return reply.status(404).send({ error: 'Not found' });
    }
    const { agentId } = request.params as { agentId: string };
    const agentConfig = getAgentConfig(agentId);
    if (!agentConfig) {
      return reply.status(404).send({ error: `Unknown agent: ${agentId}` });
    }
    if (!checkAgentAuth(request, reply, agentConfig)) return;

    const decision = allowlist.evaluate(agentId, AIRLOCK_PREPARE_UPLOAD_TOOL);
    if (decision !== 'allow') {
      const message =
        decision === 'ask'
          ? `Direct HTTP upload requires ${AIRLOCK_PREPARE_UPLOAD_TOOL} to be allowed; call ${AIRLOCK_PREPARE_UPLOAD_TOOL} via MCP for approval-gated uploads.`
          : `Agent "${agentId}" is not permitted to stage uploads (grant ${AIRLOCK_PREPARE_UPLOAD_TOOL}).`;
      return reply.status(403).send({ error: message });
    }

    const query = request.query as { filename?: string; session?: string } | undefined;
    const filename = firstHeader(request.headers['x-filename']) ?? query?.filename;
    const contentTypeHeader = firstHeader(request.headers['content-type']);
    const contentLength = parseContentLength(request.headers['content-length']);
    const isMultipart = Boolean(contentTypeHeader?.toLowerCase().startsWith('multipart/form-data'));
    const hasExplicitFilename = Boolean(filename?.trim());

    // Pre-check only fields whose final values are already known before streaming/parsing.
    // For multipart uploads (or chunked raw bodies without Content-Length), defer constraints on
    // unknown filename/MIME/size until parsing completes, then roll back on any violation.
    if (isMultipart) {
      if (hasExplicitFilename) {
        const sanitizedName = sanitizeFilename(filename);
        const prePolicyViolation = checkDirectToolPolicies(
          agentConfig,
          AIRLOCK_PREPARE_UPLOAD_TOOL,
          { filename: sanitizedName },
          new Set(['filename'])
        );
        if (prePolicyViolation) {
          return reply.status(403).send({ error: prePolicyViolation });
        }
      }
    } else {
      const sanitizedName = sanitizeFilename(filename);
      const inferredMime = inferMimeType(sanitizedName, normalizeMimeType(contentTypeHeader));
      const knownKeys = new Set<string>(['filename', 'content_type']);
      if (contentLength !== undefined) knownKeys.add('size_bytes');
      const prePolicyViolation = checkDirectToolPolicies(
        agentConfig,
        AIRLOCK_PREPARE_UPLOAD_TOOL,
        {
          filename: sanitizedName,
          content_type: inferredMime,
          ...(contentLength !== undefined ? { size_bytes: contentLength } : {}),
        },
        knownKeys
      );
      if (prePolicyViolation) {
        return reply.status(403).send({ error: prePolicyViolation });
      }
    }

    const explicitSession = firstHeader(request.headers[SESSION_HEADER]) ?? query?.session;
    const sessionId =
      isValidSessionId(explicitSession) && opts.resolveSessionId
        ? opts.resolveSessionId(agentId, explicitSession)
        : undefined;

    request.raw.setTimeout?.(0);
    reply.raw.setTimeout?.(0);
    try {
      const info = await uploadStore.createDirectUpload(agentId, {
        stream: request.raw,
        filename,
        contentTypeHeader,
        contentLength,
        agentLimits: agentConfig.uploads,
        sessionId,
      });
      // Re-check tool policies against actual finalized filename/MIME/size (e.g. multipart uploads
      // where filename or size was not present in outer HTTP headers) and roll back on violation.
      const postPolicyViolation = checkDirectToolPolicies(
        agentConfig,
        AIRLOCK_PREPARE_UPLOAD_TOOL,
        {
          filename: info.filename,
          content_type: info.content_type,
          size_bytes: info.size_bytes,
        }
      );
      if (postPolicyViolation) {
        uploadStore.deleteUpload(agentId, info.upload_id, sessionId);
        return reply.status(403).send({ error: postPolicyViolation });
      }
      return reply.status(201).send(info);
    } catch (err) {
      return sendUploadError(reply, err);
    }
  });

  app.delete('/agents/:agentId/uploads/:uploadId', async (request, reply) => {
    if (!uploadStore.isEnabled()) {
      return reply.status(404).send({ error: 'Not found' });
    }
    const { agentId, uploadId } = request.params as { agentId: string; uploadId: string };
    const agentConfig = getAgentConfig(agentId);
    if (!agentConfig) {
      return reply.status(404).send({ error: `Unknown agent: ${agentId}` });
    }
    if (!checkAgentAuth(request, reply, agentConfig)) return;

    const decision = allowlist.evaluate(agentId, AIRLOCK_DELETE_UPLOAD_TOOL);
    if (decision !== 'allow') {
      const message =
        decision === 'ask'
          ? `Direct HTTP upload deletion requires ${AIRLOCK_DELETE_UPLOAD_TOOL} to be allowed; call ${AIRLOCK_DELETE_UPLOAD_TOOL} via MCP for approval-gated deletion.`
          : `Agent "${agentId}" is not permitted to delete uploads (grant ${AIRLOCK_DELETE_UPLOAD_TOOL}).`;
      return reply.status(403).send({ error: message });
    }

    const deletePolicyViolation = checkDirectToolPolicies(agentConfig, AIRLOCK_DELETE_UPLOAD_TOOL, {
      upload_id: uploadId,
    });
    if (deletePolicyViolation) {
      return reply.status(403).send({ error: deletePolicyViolation });
    }

    const query = request.query as { session?: string } | undefined;
    const explicitSession = firstHeader(request.headers[SESSION_HEADER]) ?? query?.session;
    const sessionId =
      isValidSessionId(explicitSession) && opts.resolveSessionId
        ? opts.resolveSessionId(agentId, explicitSession)
        : undefined;

    try {
      const deleted = uploadStore.deleteUpload(agentId, uploadId, sessionId);
      if (!deleted) {
        return reply.status(404).send({ error: `Unknown upload: ${uploadId}` });
      }
      return reply.status(200).send({ deleted: true, upload_id: uploadId });
    } catch (err) {
      return reply
        .status(409)
        .send({ error: err instanceof Error ? err.message : 'Could not delete upload' });
    }
  });
}
