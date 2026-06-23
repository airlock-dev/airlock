import { randomUUID } from 'crypto';
import type { Middleware } from '../types.js';

function makeEnvelopeTag(): string {
  const boundary = randomUUID().replace(/-/g, '').slice(0, 12);
  return `untrusted-output-${boundary}`;
}

export function untrustedEnvelopeMiddleware(): Middleware {
  return async (ctx, next) => {
    const response = await next();
    const envelopeTag = makeEnvelopeTag();
    const escapedTool = ctx.toolName.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
    );
    const escapedCallId = ctx.callId.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
    );
    response.text = `<${envelopeTag} tool="${escapedTool}" call-id="${escapedCallId}">\n${response.text}\n</${envelopeTag}>`;
    return response;
  };
}
