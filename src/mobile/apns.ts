import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { connect, constants } from 'http2';
import type { ClientHttp2Session } from 'http2';

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  keyPath: string;
  bundleId: string;
  production: boolean;
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
}

export interface ApnsApprovalPayload {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  body: string;
  context?: ApnsApprovalContext;
  timeoutMs: number;
  badgeCount?: number;
  /** Several approvals notified together: one push with "approve all" / "deny all" actions. */
  batch?: ApnsApprovalBatch;
}

export interface ApnsApprovalBatch {
  id: string;
  code: string;
  /** Total members. Only the first few are itemized: APNs payloads are capped at 4KB. */
  size: number;
  /** Number of members a security check flagged; "approve all" skips these. */
  flagged: number;
  items: Array<{ id: string; code: string; tool: string; summary: string }>;
}

export interface ApnsApprovalContext {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  reason?: string;
  note?: string;
  args: Array<{ key: string; value: string }>;
  timeoutMs: number;
  expiresAt?: string;
  kind?: 'call' | 'plan' | 'question';
  tier?: string;
  provider?: string;
  escalated?: boolean;
  /** Grant scopes the companion can offer ("allow read-only gmail tools for 15m"). */
  grantOptions?: Array<{ scope: string; label: string; tier?: string; profile?: string }>;
}

export interface ApnsApprovalStatusPayload {
  id: string;
  code: string;
  result: 'approved' | 'denied' | 'timeout' | 'cancelled';
  badgeCount: number;
  /** Set when the approval belonged to a notified batch; the batch push is cleared at 0 pending. */
  batchId?: string;
  batchPending?: number;
}

export interface ApnsActivityPayload {
  id: string;
  kind: 'notification' | 'log';
  agentId: string;
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  createdAt: string;
}

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  reason?: string;
}

const JWT_TTL_MS = 50 * 60 * 1000;

export class ApnsClient {
  private privateKey: string;
  private cachedJwt?: { token: string; createdAt: number };

  constructor(private config: ApnsConfig) {
    this.privateKey = readFileSync(config.keyPath, 'utf8');
  }

  async sendApproval(deviceToken: string, approval: ApnsApprovalPayload): Promise<ApnsSendResult> {
    const authority = this.config.production
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const session = connect(authority);

    try {
      return await this.sendWithSession(session, deviceToken, approval);
    } finally {
      session.close();
    }
  }

  async sendBadge(deviceToken: string, badgeCount: number): Promise<ApnsSendResult> {
    const authority = this.config.production
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const session = connect(authority);

    try {
      return await this.sendBadgeWithSession(session, deviceToken, badgeCount);
    } finally {
      session.close();
    }
  }

  async sendApprovalStatus(
    deviceToken: string,
    status: ApnsApprovalStatusPayload
  ): Promise<ApnsSendResult> {
    const authority = this.config.production
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const session = connect(authority);

    try {
      return await this.sendApprovalStatusWithSession(session, deviceToken, status);
    } finally {
      session.close();
    }
  }

  async sendActivity(deviceToken: string, activity: ApnsActivityPayload): Promise<ApnsSendResult> {
    const authority = this.config.production
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const session = connect(authority);

    try {
      return await this.sendActivityWithSession(session, deviceToken, activity);
    } finally {
      session.close();
    }
  }

  private sendWithSession(
    session: ClientHttp2Session,
    deviceToken: string,
    approval: ApnsApprovalPayload
  ): Promise<ApnsSendResult> {
    return new Promise((resolve, reject) => {
      const payload = approvalPayloadJson(approval, this.config.interruptionLevel);

      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        authorization: `bearer ${this.jwt()}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': approval.batch?.id ?? approval.id,
        'apns-expiration': String(
          approval.timeoutMs > 0 ? Math.floor((Date.now() + approval.timeoutMs) / 1000) : 0
        ),
      });

      let status = 0;
      let responseBody = '';

      request.setEncoding('utf8');
      request.on('response', (headers) => {
        const rawStatus = headers[constants.HTTP2_HEADER_STATUS];
        status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus ?? 0);
      });
      request.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      request.on('error', reject);
      request.on('end', () => {
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status });
          return;
        }

        let reason: string | undefined;
        try {
          const parsed = JSON.parse(responseBody) as { reason?: string };
          reason = parsed.reason;
        } catch {
          reason = responseBody || undefined;
        }
        resolve({ ok: false, status, ...(reason ? { reason } : {}) });
      });
      request.end(payload);
    });
  }

  private sendActivityWithSession(
    session: ClientHttp2Session,
    deviceToken: string,
    activity: ApnsActivityPayload
  ): Promise<ApnsSendResult> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        aps: {
          alert: {
            title: activity.title || 'Airlock notification',
            body: activity.body || '',
          },
          category: 'AIRLOCK_ACTIVITY',
          sound: 'default',
          'thread-id': 'airlock-activity',
          'summary-arg': activity.agentId || 'Airlock',
          ...(this.config.interruptionLevel
            ? { 'interruption-level': this.config.interruptionLevel }
            : {}),
        },
        event: 'activity',
        activity_id: activity.id,
        kind: activity.kind,
        agent_id: activity.agentId,
        severity: activity.severity,
        created_at: activity.createdAt,
      });

      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        authorization: `bearer ${this.jwt()}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': activity.id,
        'apns-expiration': '0',
      });

      let status = 0;
      let responseBody = '';

      request.setEncoding('utf8');
      request.on('response', (headers) => {
        const rawStatus = headers[constants.HTTP2_HEADER_STATUS];
        status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus ?? 0);
      });
      request.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      request.on('error', reject);
      request.on('end', () => {
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status });
          return;
        }

        let reason: string | undefined;
        try {
          const parsed = JSON.parse(responseBody) as { reason?: string };
          reason = parsed.reason;
        } catch {
          reason = responseBody || undefined;
        }
        resolve({ ok: false, status, ...(reason ? { reason } : {}) });
      });
      request.end(payload);
    });
  }

  private sendBadgeWithSession(
    session: ClientHttp2Session,
    deviceToken: string,
    badgeCount: number
  ): Promise<ApnsSendResult> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        aps: {
          badge: normalizeBadgeCount(badgeCount) ?? 0,
        },
      });

      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        authorization: `bearer ${this.jwt()}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': '0',
      });

      let status = 0;
      let responseBody = '';

      request.setEncoding('utf8');
      request.on('response', (headers) => {
        const rawStatus = headers[constants.HTTP2_HEADER_STATUS];
        status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus ?? 0);
      });
      request.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      request.on('error', reject);
      request.on('end', () => {
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status });
          return;
        }

        let reason: string | undefined;
        try {
          const parsed = JSON.parse(responseBody) as { reason?: string };
          reason = parsed.reason;
        } catch {
          reason = responseBody || undefined;
        }
        resolve({ ok: false, status, ...(reason ? { reason } : {}) });
      });
      request.end(payload);
    });
  }

  private sendApprovalStatusWithSession(
    session: ClientHttp2Session,
    deviceToken: string,
    status: ApnsApprovalStatusPayload
  ): Promise<ApnsSendResult> {
    return new Promise((resolve, reject) => {
      // Background pushes cannot include badge, sound, or alert keys in aps.
      // The companion refreshes its badge from the current pending queue.
      const payload = JSON.stringify({
        aps: {
          'content-available': 1,
        },
        event: 'approval_resolved',
        approval_id: status.id,
        code: status.code,
        result: status.result,
        ...(status.batchId
          ? { batch_id: status.batchId, batch_pending: status.batchPending ?? 0 }
          : {}),
      });

      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        authorization: `bearer ${this.jwt()}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'background',
        'apns-priority': '5',
        'apns-collapse-id': `resolved-${status.id}`,
        'apns-expiration': '0',
      });

      let responseStatus = 0;
      let responseBody = '';

      request.setEncoding('utf8');
      request.on('response', (headers) => {
        const rawStatus = headers[constants.HTTP2_HEADER_STATUS];
        responseStatus = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus ?? 0);
      });
      request.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      request.on('error', reject);
      request.on('end', () => {
        if (responseStatus >= 200 && responseStatus < 300) {
          resolve({ ok: true, status: responseStatus });
          return;
        }

        let reason: string | undefined;
        try {
          const parsed = JSON.parse(responseBody) as { reason?: string };
          reason = parsed.reason;
        } catch {
          reason = responseBody || undefined;
        }
        resolve({ ok: false, status: responseStatus, ...(reason ? { reason } : {}) });
      });
      request.end(payload);
    });
  }

  private jwt(): string {
    const now = Date.now();
    if (this.cachedJwt && now - this.cachedJwt.createdAt < JWT_TTL_MS) {
      return this.cachedJwt.token;
    }

    const header = base64UrlJson({ alg: 'ES256', kid: this.config.keyId });
    const claims = base64UrlJson({
      iss: this.config.teamId,
      iat: Math.floor(now / 1000),
    });
    const signingInput = `${header}.${claims}`;
    const signer = createSign('SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer
      .sign({ key: this.privateKey, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    const token = `${signingInput}.${signature}`;
    this.cachedJwt = { token, createdAt: now };
    return token;
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function normalizeBadgeCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

/** APNs rejects alert payloads over 4096 bytes; stay a little under. */
export const APNS_MAX_PAYLOAD_BYTES = 4000;

/**
 * Serialize an approval alert, trimming batch items and then the body until it fits APNs' payload
 * limit — an oversized push is rejected outright and the operator would get nothing.
 */
export function approvalPayloadJson(
  approval: ApnsApprovalPayload,
  interruptionLevel?: ApnsConfig['interruptionLevel']
): string {
  const badgeCount = normalizeBadgeCount(approval.badgeCount);
  let items = approval.batch?.items ?? [];
  let body = approval.body;
  let context = approval.context;
  for (;;) {
    const batch = approval.batch ? { ...approval.batch, items } : undefined;
    const payload = JSON.stringify({
      aps: {
        alert: { title: approvalAlertTitle(approval), body },
        category: approvalCategory(approval),
        sound: 'default',
        'thread-id': 'airlock-approvals',
        'summary-arg': approval.tool,
        ...(batch ? { 'summary-arg-count': batch.size } : {}),
        ...(badgeCount !== undefined ? { badge: badgeCount } : {}),
        ...(interruptionLevel ? { 'interruption-level': interruptionLevel } : {}),
      },
      approval_id: approval.id,
      code: approval.code,
      tool: approval.tool,
      agent_id: approval.agentId,
      ...(batch
        ? {
            batch_id: batch.id,
            batch_code: batch.code,
            approval_ids: items.map((item) => item.id),
            airlock: { batch },
          }
        : context
          ? { airlock: { approval: context } }
          : {}),
    });
    if (Buffer.byteLength(payload) <= APNS_MAX_PAYLOAD_BYTES) return payload;
    if (items.length > 1) items = items.slice(0, -1);
    else if (context && context.args.length > 0)
      context = { ...context, args: context.args.slice(0, -1) };
    else if (body.length > 40) body = `${body.slice(0, Math.floor(body.length / 2))}…`;
    else return payload;
  }
}

/**
 * Batches get approve-all/deny-all. Plans, questions and flagged calls get approve/deny only:
 * "Allow 1 hour" and "Always allow" remember the tool, which only makes sense for a routine call.
 */
function approvalCategory(approval: ApnsApprovalPayload): string {
  if (approval.batch) return 'AIRLOCK_APPROVAL_BATCH';
  const context = approval.context;
  const routine =
    approval.tool !== 'airlock/ask_user' &&
    (context?.kind ?? 'call') === 'call' &&
    !context?.escalated;
  return routine ? 'AIRLOCK_APPROVAL' : 'AIRLOCK_APPROVAL_PLAIN';
}

function approvalAlertTitle(approval: ApnsApprovalPayload): string {
  if (approval.batch) return `${approval.agentId}: ${approval.batch.size} approvals`;
  if (approval.tool === 'airlock/ask_user') {
    const question = approval.context?.args.find((arg) =>
      ['question', 'title', 'message'].includes(arg.key)
    )?.value;
    const trimmed = question?.trim();
    if (trimmed) return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  }
  return `${approval.agentId}: ${approval.tool}`;
}
