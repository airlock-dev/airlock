import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
import { Gateway } from '../src/gateway.js';
import { GatewayConfig } from '../src/config/schema.js';
import { createConfigureWebApp } from '../src/configure-web/cli.js';
import type { ToolRegistry } from '../src/registry/registry.js';
import type { HitlEngine } from '../src/hitl/engine.js';
import type { ApprovalStreamHub } from '../src/hitl/approval-stream.js';
import type { AuditLogger } from '../src/audit/logger.js';

it('confines previews to operator routes and leaves denial and approved execution unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airlock-preview-integration-'));
  const configPath = join(dir, 'airlock.yaml');
  writeFileSync(configPath, 'agents:\n  reader: {}\n');
  const config = GatewayConfig.parse({
    agents: { reader: { token: 'agent-secret', ask: ['records/update'], middleware: [] } },
    approvals: {
      previews: {
        'records/update': {
          tool: 'records/read',
          args_from: { id: 'record_id' },
        },
      },
    },
    server: {
      port: 1,
      host: '127.0.0.1',
      expose_tools_api: 'all',
      auth_required: true,
      management_api: { enabled: true, host: '127.0.0.1', port: 2, api_secret: 'operator-secret' },
    },
    audit: { db_path: join(dir, 'audit.db') },
  });
  config.server.port = 0;
  config.server.management_api.port = 0;
  const gateway = new Gateway(config);
  let dashboard: FastifyInstance | undefined;
  const call = vi.fn(async ({ tool }: { tool: string }) => ({
    success: true,
    data: {
      content: [
        {
          type: 'text',
          text:
            tool === 'records/read'
              ? JSON.stringify({
                  fields: [{ label: 'Body', value: 'PRIVATE OPERATOR PREVIEW', primary: true }],
                })
              : 'AUTHORIZED ORIGINAL RESULT',
        },
      ],
    },
  }));
  try {
    await gateway.start();
    const runtime = gateway as unknown as {
      app: FastifyInstance;
      managementApp: FastifyInstance;
      registry: ToolRegistry;
      hitlEngine: HitlEngine;
      approvalStream: ApprovalStreamHub;
      auditLogger: AuditLogger;
    };
    runtime.registry.setAdapters([
      {
        id: 'api:records',
        listTools: async () => [
          { name: 'records/update', inputSchema: { type: 'object' } },
          {
            name: 'records/read',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ],
        call,
        stop: async () => {},
      },
    ]);
    await runtime.registry.refresh();
    const dataBase = `http://127.0.0.1:${(runtime.app.server.address() as AddressInfo).port}`;
    const managementBase = `http://127.0.0.1:${(runtime.managementApp.server.address() as AddressInfo).port}`;
    dashboard = createConfigureWebApp(configPath, {
      remoteGateway: { url: managementBase, secret: 'operator-secret' },
    });
    const invoke = () =>
      fetch(`${dataBase}/agents/reader/tools/invoke`, {
        method: 'POST',
        headers: { authorization: 'Bearer agent-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: 'records/update',
          args: { record_id: 'opaque', _airlock: { reason: 'Update selected record' } },
        }),
      });
    async function waitForPending() {
      await vi.waitFor(() => expect(runtime.hitlEngine.getPending()).toHaveLength(1));
      const pending = runtime.hitlEngine.getPending()[0];
      await vi.waitFor(() =>
        expect(runtime.approvalStream.getPendingById(pending.id)).toBeDefined()
      );
      return pending;
    }
    const deniedCall = invoke();
    const pending = await waitForPending();
    const url = `/approval-preview/${pending.id}`;
    expect(
      (
        await fetch(dataBase + url, {
          method: 'POST',
          headers: { authorization: 'Bearer agent-secret' },
        })
      ).status
    ).toBe(404);
    for (const secret of [undefined, 'agent-secret']) {
      expect(
        (
          await fetch(managementBase + url, {
            method: 'POST',
            headers: secret ? { authorization: `Bearer ${secret}` } : {},
          })
        ).status
      ).toBe(401);
    }
    expect(call).not.toHaveBeenCalled();
    const preview = await dashboard.inject({ method: 'POST', url });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      status: 'ready',
      text: 'Body: PRIVATE OPERATOR PREVIEW',
      fields: [{ label: 'Body', value: 'PRIVATE OPERATOR PREVIEW', primary: true }],
    });
    const companionPreview = await fetch(
      `${managementBase}/mobile/approvals/${pending.id}/preview`,
      { method: 'POST', headers: { authorization: 'Bearer operator-secret' } }
    );
    expect(companionPreview.status).toBe(200);
    expect(companionPreview.headers.get('cache-control')).toBe('no-store');
    expect(await companionPreview.json()).toEqual(preview.json());
    expect(call).toHaveBeenCalledOnce();
    for (const path of ['/hitl/pending', '/audit']) {
      const response = await fetch(managementBase + path, {
        headers: { authorization: 'Bearer operator-secret' },
      });
      expect(await response.text()).not.toContain('PRIVATE OPERATOR PREVIEW');
    }
    expect(JSON.stringify(runtime.approvalStream.getPendingById(pending.id))).not.toContain(
      'PRIVATE OPERATOR PREVIEW'
    );
    expect(runtime.registry.getFiltered('reader').map((tool) => tool.name)).not.toContain(
      'records/read'
    );
    runtime.hitlEngine.deny(pending.id);
    const denial = await deniedCall;
    expect(await denial.text()).toContain('Request denied by operator');
    expect(call).toHaveBeenCalledOnce();
    expect((await dashboard.inject({ method: 'POST', url })).statusCode).toBe(409);

    const approvedCall = invoke();
    const second = await waitForPending();
    await dashboard.inject({ method: 'POST', url: `/approval-preview/${second.id}` });
    runtime.hitlEngine.approve(second.id);
    const result = await (await approvedCall).text();
    expect(result).toContain('AUTHORIZED ORIGINAL RESULT');
    expect(result).not.toContain('PRIVATE OPERATOR PREVIEW');
    expect(call.mock.calls.map(([request]) => request.tool)).toEqual([
      'records/read',
      'records/read',
      'records/update',
    ]);
  } finally {
    await dashboard?.close();
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
