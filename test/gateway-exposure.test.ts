import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
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
        expose_management_api: false,
        expose_tools_api: false,
        expose_hook_api: false,
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
