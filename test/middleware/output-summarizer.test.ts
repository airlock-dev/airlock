import { describe, it, expect, vi } from 'vitest';
import { outputSummarizerMiddleware } from '../../src/middleware/post/output-summarizer.js';
import type { ToolCallContext, ToolCallResponse } from '../../src/middleware/types.js';

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    callId: 'test',
    agentId: 'agent1',
    agentConfig: {} as any,
    toolName: 'test/tool',
    args: {},
    meta: {},
    deps: {
      registry: {} as any,
      allowlist: {} as any,
      hitlEngine: {} as any,
      hitlBatcher: {} as any,
      auditLogger: { log: vi.fn() } as any,
      securityConfig: { blocked_hosts: [], allowed_local: [] },
    },
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeNext(text: string): () => Promise<ToolCallResponse> {
  return async () => ({ result: text, text });
}

describe('outputSummarizerMiddleware', () => {
  it('passes short output through unchanged', async () => {
    const mw = outputSummarizerMiddleware({ model: 'test-model', threshold_chars: 100 });
    const result = await mw(makeCtx(), makeNext('short'));
    expect(result.text).toBe('short');
  });

  it('attempts summarization on large output and falls back gracefully', async () => {
    // The `ai` package's generateText will fail since there's no real model configured
    // but the middleware should fall back gracefully
    const mw = outputSummarizerMiddleware({ model: 'nonexistent-model', threshold_chars: 10 });
    const longText = 'x'.repeat(100);
    const result = await mw(makeCtx(), makeNext(longText));
    // Should fall through with original text since LLM call fails
    expect(result.text).toBe(longText);
  });

  it('includes fullOutputPath in summary when available', async () => {
    // Mock the ai module
    vi.doMock('ai', () => ({
      generateText: vi.fn().mockResolvedValue({ text: 'This is a summary.' }),
    }));

    // Need to re-import after mock
    const { outputSummarizerMiddleware: mw } = await import('../../src/middleware/post/output-summarizer.js');
    const middleware = mw({ model: 'test', threshold_chars: 10 });
    const next = async (): Promise<ToolCallResponse> => ({
      result: 'long',
      text: 'x'.repeat(100),
      fullOutputPath: '/tmp/airlock/agent1/test.txt',
    });
    const result = await middleware(makeCtx(), next);
    expect(result.text).toContain('<summary>');
    expect(result.text).toContain('This is a summary.');
    expect(result.text).toContain('<full-output>/tmp/airlock/agent1/test.txt</full-output>');

    vi.doUnmock('ai');
  });

  it('returns original text when generateText throws', async () => {
    vi.doMock('ai', () => ({
      generateText: vi.fn().mockRejectedValue(new Error('API key missing')),
    }));

    const { outputSummarizerMiddleware: mw } = await import('../../src/middleware/post/output-summarizer.js');
    const middleware = mw({ model: 'test', threshold_chars: 10 });
    const longText = 'important data '.repeat(20);
    const result = await middleware(makeCtx(), makeNext(longText));
    expect(result.text).toBe(longText);

    vi.doUnmock('ai');
  });
});
