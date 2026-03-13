import type { Middleware } from '../types.js';

export function untrustedEnvelopeMiddleware(): Middleware {
  return async (ctx, next) => {
    const response = await next();
    const escapedTool = ctx.toolName.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
    );
    const escapedCallId = ctx.callId.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
    );
    response.text = `<untrusted-output tool="${escapedTool}" call-id="${escapedCallId}">\n${response.text}\n</untrusted-output>`;
    return response;
  };
}
