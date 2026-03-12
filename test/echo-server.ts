/**
 * Standalone echo MCP server for testing.
 *
 * Exports `createDownstreamServer()` for in-process test use, and runs as a
 * stdio MCP server when executed directly:
 *
 *   npx tsx test/echo-server.ts
 *
 * Tools:
 *   - echo: returns { message } back
 *   - add:  returns the sum of { a, b }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const DOWNSTREAM_TOOLS: Tool[] = [
  {
    name: 'echo',
    description: 'Returns the message back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
  },
];

export function createDownstreamServer(): Server {
  const server = new Server(
    { name: 'echo-mcp', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: DOWNSTREAM_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    if (req.params.name === 'echo') {
      return { content: [{ type: 'text', text: String(args['message'] ?? '') }] };
    }
    if (req.params.name === 'add') {
      const result = Number(args['a']) + Number(args['b']);
      return { content: [{ type: 'text', text: String(result) }] };
    }
    throw new Error(`Unknown tool: ${req.params.name}`);
  });

  return server;
}

// Run as standalone stdio server when executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/echo-server.ts') ||
  process.argv[1].endsWith('/echo-server.js')
);

if (isMain) {
  const server = createDownstreamServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
