import { describe, it, expect, afterEach } from 'vitest';
import { request, type ClientRequest } from 'http';
import type { AddressInfo } from 'net';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Gateway } from '../src/gateway.js';
import { GatewayConfig } from '../src/config/schema.js';

/** Open a long-lived SSE stream and resolve once the response headers arrive. */
function openStream(port: number, path: string, token: string): Promise<ClientRequest> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        res.on('data', () => {});
        res.on('error', () => {});
        if (res.statusCode !== 200) reject(new Error(`${path} answered ${res.statusCode}`));
        else resolve(req);
      }
    );
    req.on('error', () => {});
    req.end();
  });
}

describe('Gateway shutdown with open streams', () => {
  const tempDirs: string[] = [];
  const clients: ClientRequest[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('stops promptly while approval and agent SSE streams are connected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-runtime-shutdown-'));
    tempDirs.push(dir);

    const config = GatewayConfig.parse({
      agents: { test: { token: 'agent-secret' } },
      server: {
        port: 1,
        host: '127.0.0.1',
        auth_required: true,
        management_api: { enabled: true, api_secret: 'admin-secret', port: 1, host: '127.0.0.1' },
      },
      audit: { db_path: join(dir, 'audit.db') },
    });
    config.server.port = 0;
    config.server.management_api.port = 0;

    const gateway = new Gateway(config);
    await gateway.start();

    const agentApp = (gateway as unknown as { app: FastifyInstance }).app;
    const managementApp = (gateway as unknown as { managementApp: FastifyInstance }).managementApp;
    const agentPort = (agentApp.server.address() as AddressInfo).port;
    const managementPort = (managementApp.server.address() as AddressInfo).port;

    clients.push(
      await openStream(managementPort, '/mobile/approvals/stream', 'admin-secret'),
      await openStream(managementPort, '/events', 'admin-secret'),
      await openStream(agentPort, '/agents/test/sse', 'agent-secret')
    );

    const startedAt = Date.now();
    const outcome = await Promise.race([
      gateway.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3000).unref()),
    ]);

    expect(outcome).toBe('stopped');
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('stops promptly while a 2025-era Streamable HTTP tools/call is parked on HITL approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-runtime-shutdown-http-'));
    tempDirs.push(dir);

    const config = GatewayConfig.parse({
      providers: { exec: 'builtin' },
      agents: {
        test: {
          token: 'agent-secret',
          ask: ['exec/run'],
          exec: { ask: ['echo *'] },
        },
      },
      server: {
        port: 1,
        host: '127.0.0.1',
        auth_required: true,
        management_api: { enabled: false },
      },
      approvals: {
        provider: { type: 'webhook', url: 'http://127.0.0.1:1/noop' },
        timeout_ms: 60000,
      },
      audit: { db_path: join(dir, 'audit.db') },
    });
    config.server.port = 0;

    const gateway = new Gateway(config);
    await gateway.start();

    const agentApp = (gateway as unknown as { app: FastifyInstance }).app;
    const agentPort = (agentApp.server.address() as AddressInfo).port;

    // Open a 2025-era Streamable HTTP tools/call (no 2026-07-28 header) that parks on HITL approval.
    const parked = await new Promise<ClientRequest>((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'exec_run', arguments: { command: 'echo hi' } },
      });
      const req = request(
        {
          host: '127.0.0.1',
          port: agentPort,
          path: '/agents/test/mcp',
          method: 'POST',
          headers: {
            Authorization: 'Bearer agent-secret',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-03-26',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('error', () => {});
          if (res.statusCode !== 200) reject(new Error(`MCP answered ${res.statusCode}`));
          else resolve(req);
        }
      );
      req.on('error', () => {});
      req.end(body);
    });
    clients.push(parked);

    const startedAt = Date.now();
    const outcome = await Promise.race([
      gateway.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3000).unref()),
    ]);

    expect(outcome).toBe('stopped');
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });
});
