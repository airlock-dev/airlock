import type { AuditLogger } from '../../audit/logger.js';
import { childLogger } from '../../util/logger.js';
import {
  ApnsClient,
  type ApnsApprovalContext,
  type ApnsApprovalPayload,
  type ApnsConfig,
} from '../../mobile/apns.js';
import type { AirlockActivityEvent } from '../../activity/stream.js';
import type { HitlNotification, HitlProvider } from './types.js';

const log = childLogger('hitl-ios');

export type IOSHitlProviderConfig = ApnsConfig;

export class IOSHitlProvider implements HitlProvider {
  private apns: ApnsClient;

  constructor(
    private config: IOSHitlProviderConfig,
    private auditLogger: AuditLogger
  ) {
    this.apns = new ApnsClient(config);
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  async notify(requests: HitlNotification[]): Promise<void> {
    const devices = this.auditLogger.getActiveMobileDevices();
    if (devices.length === 0) {
      log.debug('No iOS devices registered for APNs approval notification');
      return;
    }

    // One push per notified batch (with approve-all / deny-all actions), one per lone request.
    const pushes: ApnsApprovalPayload[] = [];
    const batches = new Map<string, HitlNotification[]>();
    // Flagged calls, plans and questions are never part of "approve all", so they always get their
    // own push rather than hiding inside a batch.
    for (const request of requests) {
      const bulkApprovable = !request.escalated && (request.kind ?? 'call') === 'call';
      if (request.batchId && (request.batchSize ?? 0) > 1 && bulkApprovable) {
        const members = batches.get(request.batchId) ?? [];
        members.push(request);
        batches.set(request.batchId, members);
      } else {
        pushes.push(approvalPayload(request));
      }
    }
    for (const members of batches.values()) {
      if (members.length > 1) pushes.push(batchPayload(members));
      else pushes.push(...members.map(approvalPayload));
    }

    for (const push of pushes) {
      const results = await Promise.allSettled(
        devices.map((device) => this.apns.sendApproval(device.push_token, push))
      );

      results.forEach((result, index) => {
        const device = devices[index];
        if (!device) return;
        if (result.status === 'rejected') {
          log.warn({ err: result.reason, deviceId: device.id }, 'Failed to send APNs approval');
          return;
        }
        if (!result.value.ok) {
          log.warn(
            {
              deviceId: device.id,
              status: result.value.status,
              reason: result.value.reason,
            },
            'APNs rejected approval notification'
          );
        }
      });
    }
  }

  async updateBadge(badgeCount: number): Promise<void> {
    const devices = this.auditLogger.getActiveMobileDevices();
    if (devices.length === 0) {
      log.debug('No iOS devices registered for APNs badge update');
      return;
    }

    const results = await Promise.allSettled(
      devices.map((device) => this.apns.sendBadge(device.push_token, badgeCount))
    );

    results.forEach((result, index) => {
      const device = devices[index];
      if (!device) return;
      if (result.status === 'rejected') {
        log.warn({ err: result.reason, deviceId: device.id }, 'Failed to send APNs badge update');
        return;
      }
      if (!result.value.ok) {
        log.warn(
          {
            deviceId: device.id,
            status: result.value.status,
            reason: result.value.reason,
          },
          'APNs rejected badge update'
        );
      }
    });
  }

  async updateApprovalStatus(status: {
    id: string;
    code: string;
    result: 'approved' | 'denied' | 'timeout' | 'cancelled';
    badgeCount: number;
  }): Promise<void> {
    const devices = this.auditLogger.getActiveMobileDevices();
    if (devices.length === 0) {
      log.debug('No iOS devices registered for APNs approval status update');
      return;
    }

    const results = await Promise.allSettled(
      devices.map((device) => this.apns.sendApprovalStatus(device.push_token, status))
    );

    results.forEach((result, index) => {
      const device = devices[index];
      if (!device) return;
      if (result.status === 'rejected') {
        log.warn(
          { err: result.reason, deviceId: device.id },
          'Failed to send APNs approval status update'
        );
        return;
      }
      if (!result.value.ok) {
        log.warn(
          {
            deviceId: device.id,
            status: result.value.status,
            reason: result.value.reason,
          },
          'APNs rejected approval status update'
        );
      }
    });
  }

  async notifyActivity(event: AirlockActivityEvent): Promise<void> {
    if (event.kind !== 'notification') return;

    const devices = this.auditLogger.getActiveMobileDevices();
    if (devices.length === 0) {
      log.debug('No iOS devices registered for APNs activity notification');
      return;
    }

    const results = await Promise.allSettled(
      devices.map((device) => this.apns.sendActivity(device.push_token, event))
    );

    results.forEach((result, index) => {
      const device = devices[index];
      if (!device) return;
      if (result.status === 'rejected') {
        log.warn(
          { err: result.reason, deviceId: device.id },
          'Failed to send APNs activity notification'
        );
        return;
      }
      if (!result.value.ok) {
        log.warn(
          {
            deviceId: device.id,
            status: result.value.status,
            reason: result.value.reason,
          },
          'APNs rejected activity notification'
        );
      }
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

function approvalPayload(request: HitlNotification): ApnsApprovalPayload {
  return {
    id: request.id,
    code: request.code,
    agentId: request.agentId,
    tool: request.tool,
    body: approvalBody(request),
    context: approvalContext(request),
    timeoutMs: request.timeoutMs,
    ...(request.badgeCount !== undefined ? { badgeCount: request.badgeCount } : {}),
  };
}

/** APNs payloads are capped at 4KB, so a batch push carries short summaries, not full args. */
const MAX_BATCH_ITEMS = 12;

function batchPayload(members: HitlNotification[]): ApnsApprovalPayload {
  const first = members[0];
  const items = members.slice(0, MAX_BATCH_ITEMS).map((member) => ({
    id: member.id,
    code: member.code,
    tool: member.tool,
    summary: oneLineSummary(member),
  }));
  const flagged = members.filter((member) => member.escalated).length;
  const lines = items.map((item) => `• ${item.tool}${item.summary ? ` — ${item.summary}` : ''}`);
  if (members.length > items.length) lines.push(`+${members.length - items.length} more`);
  if (flagged > 0) lines.push(`⚠️ ${flagged} flagged — approve all skips them`);
  return {
    id: first.id,
    code: first.code,
    agentId: first.agentId,
    tool: first.tool,
    body: lines.join('\n').slice(0, 900),
    timeoutMs: first.timeoutMs,
    ...(first.badgeCount !== undefined ? { badgeCount: first.badgeCount } : {}),
    batch: {
      id: first.batchId!,
      code: first.batchCode ?? first.code,
      approvalIds: members.map((member) => member.id),
      flagged,
      items,
    },
  };
}

function oneLineSummary(request: HitlNotification): string {
  const [entry] = Object.entries(request.args).sort(([a], [b]) => a.localeCompare(b));
  if (!entry) return '';
  return `${entry[0]}: ${formatValue(entry[1])}`.slice(0, 60);
}

function approvalBody(request: HitlNotification): string {
  const entries = Object.entries(request.args).sort(([a], [b]) => a.localeCompare(b));
  const contextLines = [
    request.context?.reason ? `Request reason: ${request.context.reason}` : undefined,
    request.context?.note ? `Request note: ${request.context.note}` : undefined,
  ].filter((line): line is string => Boolean(line));

  if (entries.length === 0) return (contextLines.join('\n') || 'No arguments').slice(0, 900);

  const lines = entries.slice(0, 6).map(([key, value]) => `${key}: ${formatValue(value)}`);
  if (entries.length > lines.length) {
    lines.push(`+${entries.length - lines.length} more`);
  }
  return [...contextLines, ...lines].join('\n').slice(0, 900);
}

function approvalContext(request: HitlNotification): ApnsApprovalContext {
  return {
    id: request.id,
    code: request.code,
    agentId: request.agentId,
    tool: request.tool,
    ...(request.context?.reason ? { reason: request.context.reason } : {}),
    ...(request.context?.note ? { note: request.context.note } : {}),
    args: Object.entries(request.args)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 8)
      .map(([key, value]) => ({ key, value: formatValue(value) })),
    timeoutMs: request.timeoutMs,
    ...(request.timeoutMs > 0
      ? { expiresAt: new Date(Date.now() + request.timeoutMs).toISOString() }
      : {}),
    ...(request.kind ? { kind: request.kind } : {}),
    ...(request.tier ? { tier: request.tier } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.escalated ? { escalated: true } : {}),
    ...(request.grantOptions?.length ? { grantOptions: request.grantOptions } : {}),
  };
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
    }
  } catch {
    return '[unserializable]';
  }
  return '[unserializable]';
}
