/**
 * Integration test — spawns Airlock as a real child process over stdio,
 * connects with the MCP SDK client, and exercises the full stack end-to-end.
 *
 * This is the same thing MCP Inspector does, but automated.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG = resolve(ROOT, 'test/test-gateway.yaml');

describe('integration: stdio child process', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/index.ts', '--profile', 'test', '--config', CONFIG],
      cwd: ROOT,
    });

    client = new Client({ name: 'integration-test', version: '0.0.1' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists tools from the downstream echo server', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);

    expect(names).toContain('tools/echo');
    expect(names).toContain('tools/add');
  });

  it('tools have proper input schemas', async () => {
    const { tools } = await client.listTools();
    const echo = tools.find(t => t.name === 'tools/echo');

    expect(echo).toBeDefined();
    expect(echo!.inputSchema).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
  });

  it('calls tools/echo and gets the message back', async () => {
    const result = await client.callTool({
      name: 'tools/echo',
      arguments: { message: 'hello from integration test' },
    });

    const outer = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(outer.content[0].text).toBe('hello from integration test');
  });

  it('calls tools/add and gets the sum', async () => {
    const result = await client.callTool({
      name: 'tools/add',
      arguments: { a: 17, b: 25 },
    });

    const outer = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(outer.content[0].text).toBe('42');
  });

  it('rejects tools not in the allowlist', async () => {
    await expect(
      client.callTool({ name: 'http/get', arguments: { url: 'http://example.com' } }),
    ).rejects.toThrow();
  });

  it('rejects completely unknown tools', async () => {
    await expect(
      client.callTool({ name: 'nope/doesnt_exist', arguments: {} }),
    ).rejects.toThrow();
  });
});
