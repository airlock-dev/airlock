import type { AuditLogger } from '../../audit/logger.js';
import { childLogger } from '../../util/logger.js';
import { ApnsClient, type ApnsApprovalContext, type ApnsConfig } from '../../mobile/apns.js';
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

    for (const request of requests) {
      const body = approvalBody(request);
      const results = await Promise.allSettled(
        devices.map((device) =>
          this.apns.sendApproval(device.push_token, {
            id: request.id,
            code: request.code,
            agentId: request.agentId,
            tool: request.tool,
            body,
            context: approvalContext(request),
            timeoutMs: request.timeoutMs,
            ...(request.badgeCount !== undefined ? { badgeCount: request.badgeCount } : {}),
          })
        )
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
