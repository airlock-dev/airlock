import type { Middleware, ToolCallContext, ToolCallResponse } from './types.js';

export function compose(middlewares: Middleware[]): Middleware {
  return function composed(ctx: ToolCallContext, finalNext: () => Promise<ToolCallResponse>) {
    let index = -1;

    function dispatch(i: number): Promise<ToolCallResponse> {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      index = i;

      const fn = i < middlewares.length ? middlewares[i] : finalNext;
      return fn(ctx, () => dispatch(i + 1));
    }

    return dispatch(0);
  };
}
