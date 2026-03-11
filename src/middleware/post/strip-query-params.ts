import type { Middleware } from '../types.js';

const READ_ONLY_HTTP_TOOLS = new Set(['http/get', 'http/head']);

export function stripQueryParamsMiddleware(): Middleware {
  return async (ctx, next) => {
    if (!READ_ONLY_HTTP_TOOLS.has(ctx.toolName)) return next();

    const url = ctx.args['url'];
    if (typeof url !== 'string') return next();

    try {
      const parsed = new URL(url);
      if (parsed.search) {
        parsed.search = '';
        ctx.args['url'] = parsed.toString();
      }
    } catch {
      // Invalid URL — let downstream handle it
    }

    return next();
  };
}
