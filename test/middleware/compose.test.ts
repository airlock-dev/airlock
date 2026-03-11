import { describe, it, expect } from 'vitest';
import { compose } from '../../src/middleware/compose.js';
import type { Middleware, ToolCallContext, ToolCallResponse } from '../../src/middleware/types.js';

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    callId: 'test-call',
    agentId: 'agent1',
    agentConfig: {} as any,
    toolName: 'test/tool',
    args: {},
    meta: {},
    deps: {} as any,
    startedAt: Date.now(),
    ...overrides,
  };
}

const okResponse: ToolCallResponse = { result: 'ok', text: 'ok' };

describe('compose', () => {
  it('calls middlewares in order', async () => {
    const order: number[] = [];
    const m1: Middleware = async (_ctx, next) => { order.push(1); const r = await next(); order.push(4); return r; };
    const m2: Middleware = async (_ctx, next) => { order.push(2); const r = await next(); order.push(3); return r; };
    const chain = compose([m1, m2]);

    await chain(makeCtx(), async () => okResponse);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('allows short-circuiting without calling next', async () => {
    const earlyReturn: ToolCallResponse = { result: 'blocked', text: 'blocked' };
    const m1: Middleware = async () => earlyReturn;
    const m2: Middleware = async (_ctx, next) => next();
    const chain = compose([m1, m2]);

    const result = await chain(makeCtx(), async () => okResponse);
    expect(result.text).toBe('blocked');
  });

  it('rejects double next() calls', async () => {
    const bad: Middleware = async (_ctx, next) => {
      await next();
      return next();
    };
    const chain = compose([bad]);

    await expect(chain(makeCtx(), async () => okResponse)).rejects.toThrow('next() called multiple times');
  });

  it('middlewares can modify ctx.args', async () => {
    const modifier: Middleware = async (ctx, next) => {
      ctx.args['injected'] = true;
      return next();
    };
    const checker: Middleware = async (ctx, next) => {
      expect(ctx.args['injected']).toBe(true);
      return next();
    };
    const chain = compose([modifier, checker]);

    await chain(makeCtx(), async () => okResponse);
  });

  it('middlewares can wrap response', async () => {
    const wrapper: Middleware = async (ctx, next) => {
      const r = await next();
      r.text = `<wrapped>${r.text}</wrapped>`;
      return r;
    };
    const chain = compose([wrapper]);

    const result = await chain(makeCtx(), async () => ({ result: 'x', text: 'hello' }));
    expect(result.text).toBe('<wrapped>hello</wrapped>');
  });

  it('works with empty middleware list', async () => {
    const chain = compose([]);
    const result = await chain(makeCtx(), async () => okResponse);
    expect(result.text).toBe('ok');
  });
});
