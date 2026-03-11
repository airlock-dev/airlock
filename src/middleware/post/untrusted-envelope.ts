import type { Middleware } from '../types.js';

export function untrustedEnvelopeMiddleware(): Middleware {
  return async (ctx, next) => {
    const response = await next();
    response.text = `<untrusted-output tool="${ctx.toolName}" call-id="${ctx.callId}">\n${response.text}\n</untrusted-output>`;
    return response;
  };
}
