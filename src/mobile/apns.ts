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
}

export interface ApnsApprovalContext {
  id: string;
  code: string;
  agentId: string;
  tool: string;
  args: Array<{ key: string; value: string }>;
  timeoutMs: number;
  expiresAt?: string;
}

export interface ApnsApprovalStatusPayload {
  id: string;
  code: string;
  result: 'approved' | 'denied' | 'timeout' | 'cancelled';
  badgeCount: number;
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

  private sendWithSession(
    session: ClientHttp2Session,
    deviceToken: string,
    approval: ApnsApprovalPayload
  ): Promise<ApnsSendResult> {
    return new Promise((resolve, reject) => {
      const badgeCount = normalizeBadgeCount(approval.badgeCount);
      const payload = JSON.stringify({
        aps: {
          alert: {
            title: `${approval.agentId}: ${approval.tool}`,
            body: approval.body,
          },
          category: 'AIRLOCK_APPROVAL',
          sound: 'default',
          'thread-id': 'airlock-approvals',
          'summary-arg': approval.tool,
          ...(badgeCount !== undefined ? { badge: badgeCount } : {}),
          ...(this.config.interruptionLevel
            ? { 'interruption-level': this.config.interruptionLevel }
            : {}),
        },
        approval_id: approval.id,
        code: approval.code,
        tool: approval.tool,
        agent_id: approval.agentId,
        ...(approval.context ? { airlock: { approval: approval.context } } : {}),
      });

      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        authorization: `bearer ${this.jwt()}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': approval.id,
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
      const payload = JSON.stringify({
        aps: {
          'content-available': 1,
          badge: normalizeBadgeCount(status.badgeCount) ?? 0,
        },
        event: 'approval_resolved',
        approval_id: status.id,
        code: status.code,
        result: status.result,
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
