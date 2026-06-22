import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
import { createServer } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Gateway } from '../src/gateway.js';
import { GatewayConfig } from '../src/config/schema.js';

describe('Gateway exposure controls', () => {
  const tempDirs: string[] = [];
  const gateways: Gateway[] = [];

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can expose only the MCP transport routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-gateway-exposure-'));
    tempDirs.push(dir);

    const config = GatewayConfig.parse({
      agents: {
        test: {
          token: 'agent-secret',
        },
      },
      server: {
        port: 1,
        host: '127.0.0.1',
        auth_required: true,
        expose_tools_api: false,
        management_api: {
          enabled: false,
        },
      },
      audit: {
        db_path: join(dir, 'audit.db'),
      },
    });
    config.server.port = 0;

    const gateway = new Gateway(config);
    gateways.push(gateway);
    await gateway.start();

    const app = (gateway as unknown as { app: FastifyInstance }).app;
    const port = (app.server.address() as AddressInfo).port;

    const [health, tools, hook, mcp] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/health`),
      fetch(`http://127.0.0.1:${port}/agents/test/tools`),
      fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST' }),
      fetch(`http://127.0.0.1:${port}/agents/test/mcp`, { method: 'POST' }),
    ]);

    expect(health.status).toBe(404);
    expect(tools.status).toBe(404);
    expect(hook.status).toBe(404);
    expect(mcp.status).toBe(401);
  });

  it('serves control-plane routes only on the management listener', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-gateway-management-'));
    tempDirs.push(dir);

    const config = GatewayConfig.parse({
      agents: {
        test: {
          token: 'agent-secret',
        },
      },
      server: {
        port: 1,
        host: '127.0.0.1',
        api_secret: 'admin-secret',
        auth_required: true,
        management_api: {
          enabled: true,
          port: 1,
          host: '127.0.0.1',
        },
      },
      audit: {
        db_path: join(dir, 'audit.db'),
      },
    });
    config.server.port = 0;
    config.server.management_api.port = 0;

    const gateway = new Gateway(config);
    gateways.push(gateway);
    await gateway.start();

    const agentApp = (gateway as unknown as { app: FastifyInstance }).app;
    const managementApp = (gateway as unknown as { managementApp: FastifyInstance }).managementApp;
    const agentPort = (agentApp.server.address() as AddressInfo).port;
    const managementPort = (managementApp.server.address() as AddressInfo).port;

    expect(agentPort).not.toBe(managementPort);

    const agentControlRoutes = await Promise.all([
      fetch(`http://127.0.0.1:${agentPort}/health`),
      fetch(`http://127.0.0.1:${agentPort}/admin/tools`),
      fetch(`http://127.0.0.1:${agentPort}/audit`),
      fetch(`http://127.0.0.1:${agentPort}/hitl/pending`),
      fetch(`http://127.0.0.1:${agentPort}/mobile/devices`),
      fetch(`http://127.0.0.1:${agentPort}/hook`, { method: 'POST' }),
    ]);

    for (const response of agentControlRoutes) {
      expect(response.status).toBe(404);
    }

    const [
      unauthorizedHealth,
      health,
      audit,
      hitl,
      mobileDevices,
      adminTools,
      dataPlaneTools,
      controlPlaneTools,
    ] = await Promise.all([
      fetch(`http://127.0.0.1:${managementPort}/health`),
      fetch(`http://127.0.0.1:${managementPort}/health`, {
        headers: { authorization: 'Bearer admin-secret' },
      }),
      fetch(`http://127.0.0.1:${managementPort}/audit`, {
        headers: { authorization: 'Bearer admin-secret' },
      }),
      fetch(`http://127.0.0.1:${managementPort}/hitl/pending`, {
        headers: { authorization: 'Bearer admin-secret' },
      }),
      fetch(`http://127.0.0.1:${managementPort}/mobile/devices`, {
        headers: { authorization: 'Bearer admin-secret' },
      }),
      fetch(`http://127.0.0.1:${managementPort}/admin/tools`, {
        headers: { authorization: 'Bearer admin-secret' },
      }),
      fetch(`http://127.0.0.1:${agentPort}/agents/test/tools`, {
        headers: { authorization: 'Bearer agent-secret' },
      }),
      fetch(`http://127.0.0.1:${managementPort}/agents/test/tools`, {
        headers: { authorization: 'Bearer agent-secret' },
      }),
    ]);

    expect(unauthorizedHealth.status).toBe(401);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      dataPlane: {
        status: 'ok',
        host: '127.0.0.1',
        port: agentPort,
      },
      mcpHealth: {},
    });
    expect(audit.status).toBe(200);
    expect(hitl.status).toBe(200);
    expect(mobileDevices.status).toBe(200);
    expect(adminTools.status).toBe(200);
    expect(dataPlaneTools.status).toBe(200);
    expect(controlPlaneTools.status).toBe(404);
  });

  it('refuses unsafe management listener configs before binding sockets', async () => {
    const missingSecret = GatewayConfig.parse({
      server: {
        management_api: {
          enabled: true,
        },
      },
    });
    await expect(new Gateway(missingSecret).start()).rejects.toThrow(
      /requires server\.api_secret/i
    );

    const tokenlessAgent = GatewayConfig.parse({
      server: {
        api_secret: 'admin-secret',
        management_api: {
          enabled: true,
        },
      },
      agents: {
        test: {},
      },
    });
    await expect(new Gateway(tokenlessAgent).start()).rejects.toThrow(/requires per-agent tokens/i);

    const remoteBind = GatewayConfig.parse({
      server: {
        api_secret: 'admin-secret',
        management_api: {
          enabled: true,
          host: '0.0.0.0',
        },
      },
    });
    await expect(new Gateway(remoteBind).start()).rejects.toThrow(/insecure_remote_bind/i);

    const sharedPort = GatewayConfig.parse({
      server: {
        port: 4111,
        api_secret: 'admin-secret',
        management_api: {
          enabled: true,
          port: 4111,
        },
      },
    });
    await expect(new Gateway(sharedPort).start()).rejects.toThrow(/must not share a socket/i);
  });

  it('closes the data-plane listener if the management listener fails to bind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-gateway-bind-failure-'));
    tempDirs.push(dir);
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const blockedPort = (blocker.address() as AddressInfo).port;

    const config = GatewayConfig.parse({
      agents: {
        test: {
          token: 'agent-secret',
        },
      },
      server: {
        port: 1,
        host: '127.0.0.1',
        api_secret: 'admin-secret',
        auth_required: true,
        management_api: {
          enabled: true,
          port: blockedPort,
          host: '127.0.0.1',
        },
      },
      audit: {
        db_path: join(dir, 'audit.db'),
      },
    });
    config.server.port = 0;
    const gateway = new Gateway(config);

    try {
      await expect(gateway.start()).rejects.toThrow(/EADDRINUSE/i);
      const agentApp = (gateway as unknown as { app: FastifyInstance }).app;
      expect(agentApp.server.listening).toBe(false);
    } finally {
      blocker.close();
      await gateway.stop();
    }
  });

  it('requires REST session ids for configured MCP provider tools and aliases', () => {
    const config = GatewayConfig.parse({
      providers: {
        messages: { type: 'stdio', command: 'bb-mcp' },
        exec: 'builtin',
      },
      agents: {
        test: {
          allow: ['*'],
          tool_overrides: {
            reply: { alias_of: 'messages/send_message' },
            shell: { alias_of: 'exec/run' },
          },
        },
      },
    });
    const gateway = new Gateway(config);
    const requiresSessionId = (
      gateway as unknown as {
        requiresToolsApiSessionId(agentId: string, toolName: string): boolean;
      }
    ).requiresToolsApiSessionId.bind(gateway);

    expect(requiresSessionId('test', 'messages/get_chat_messages')).toBe(true);
    expect(requiresSessionId('test', 'reply')).toBe(true);
    expect(requiresSessionId('test', 'exec/run')).toBe(false);
    expect(requiresSessionId('test', 'shell')).toBe(false);
  });
});
