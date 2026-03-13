import { describe, it, expect } from 'vitest';
import { callToolRequestToToolCall, toolResultToCallToolResult } from '../src/transport/mcp-normalizer.js';

describe('callToolRequestToToolCall()', () => {
  it('converts name, args, agentId to ToolCall', () => {
    const result = callToolRequestToToolCall('github/create_pr', { repo: 'test' }, 'agent1');
    expect(result).toEqual({
      tool: 'github/create_pr',
      args: { repo: 'test' },
      agentId: 'agent1',
    });
  });
});

describe('toolResultToCallToolResult()', () => {
  it('converts successful ToolResult to MCP format', () => {
    const result = toolResultToCallToolResult({ success: true, data: { number: 42 } });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({ number: 42 });
  });

  it('throws on failed ToolResult', () => {
    expect(() => toolResultToCallToolResult({ success: false, error: 'Not found' })).toThrow('Not found');
  });

  it('throws with default message when error is empty', () => {
    expect(() => toolResultToCallToolResult({ success: false })).toThrow('Unknown error');
  });
});
