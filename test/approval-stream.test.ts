import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'http';
import { ApprovalStreamHub } from '../src/hitl/approval-stream.js';

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk: string | Buffer) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    return true;
  }

  end() {
    this.ended = true;
    return this;
  }
}

function attachClient(hub: ApprovalStreamHub) {
  const requestRaw = new EventEmitter();
  const responseRaw = new FakeResponse();
  const request = { raw: requestRaw } as unknown as FastifyRequest;
  const reply = {
    hijack: vi.fn(),
    raw: responseRaw as unknown as ServerResponse,
  } as unknown as FastifyReply;

  hub.addClient(request, reply);
  return { requestRaw, responseRaw, reply };
}

function dataMessages(response: FakeResponse): Array<Record<string, unknown>> {
  return response.chunks
    .join('')
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

describe('ApprovalStreamHub', () => {
  it('replays pending approvals and recent activity when a client connects', async () => {
    const activity = {
      id: 'activity-1',
      kind: 'notification' as const,
      agentId: 'dev',
      title: 'Build finished',
      body: 'Tests passed',
      severity: 'success' as const,
      createdAt: '2026-06-24T12:00:00.000Z',
    };
    const hub = new ApprovalStreamHub({ activityStream: { recent: () => [activity] } });
    await hub.notify([
      {
        id: 'req-1',
        code: 'ABC123',
        agentId: 'dev',
        tool: 'exec/run',
        args: { command: 'pwd' },
        timeoutMs: 300000,
      },
    ]);

    const { requestRaw, responseRaw, reply } = attachClient(hub);

    expect(reply.hijack).toHaveBeenCalledOnce();
    expect(responseRaw.statusCode).toBe(200);
    expect(responseRaw.headers).toMatchObject({
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    expect(dataMessages(responseRaw)).toEqual([
      expect.objectContaining({
        type: 'new',
        request: expect.objectContaining({ code: 'ABC123', timeoutMs: 300000 }),
      }),
      expect.objectContaining({
        type: 'activity',
        event: expect.objectContaining({ id: 'activity-1' }),
      }),
    ]);

    requestRaw.emit('close');
    await hub.stop();
  });

  it('broadcasts engine resolution statuses and stops replaying resolved approvals', async () => {
    const hub = new ApprovalStreamHub();
    await hub.notify([
      {
        id: 'req-1',
        code: 'ABC123',
        agentId: 'dev',
        tool: 'exec/run',
        args: {},
        timeoutMs: 300000,
      },
    ]);
    const first = attachClient(hub);

    await hub.updateApprovalStatus({
      id: 'req-1',
      code: 'ABC123',
      result: 'approved',
      badgeCount: 0,
    });

    expect(dataMessages(first.responseRaw)).toContainEqual(
      expect.objectContaining({
        type: 'resolved',
        id: 'req-1',
        code: 'ABC123',
        action: 'approved',
        result: 'approved',
        badgeCount: 0,
      })
    );

    const second = attachClient(hub);
    expect(dataMessages(second.responseRaw).some((message) => message.type === 'new')).toBe(false);

    first.requestRaw.emit('close');
    second.requestRaw.emit('close');
    await hub.stop();
  });
});
