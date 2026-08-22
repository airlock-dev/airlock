import { randomUUID } from 'crypto';
import { isAirlockTool } from '../../airlock/tools.js';
import type { Middleware } from '../types.js';

function makeEnvelopeTag(): string {
  const boundary = randomUUID().replace(/-/g, '').slice(0, 12);
  return `untrusted-output-${boundary}`;
}

export function untrustedEnvelopeMiddleware(): Middleware {
  return async (ctx, next) => {
    const response = await next();

    // The airlock/* provider is implemented in-process by the gateway. Its responses are
    // first-party control/status data (and, for ask_user, the operator's direct answer), not
    // content returned by a downstream provider. Preserve that provenance instead of labeling
    // it as untrusted. All external and sidecar providers remain enveloped by default.
    if (isAirlockTool(ctx.toolName)) return response;

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
