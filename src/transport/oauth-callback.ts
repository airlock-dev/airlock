import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  OAUTH_CALLBACK_RESPONSE_HEADERS,
  type OAuthCallbackRouter,
} from '../pool/oauth-callback-router.js';

export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/**
 * Browser-facing OAuth redirect target for providers with `oauth_callback_mode: gateway`.
 *
 * This one GET route is deliberately outside agent bearer auth: the browser arriving from the
 * authorization server cannot carry an Airlock token. It is safe to expose because it does nothing
 * unless the request's `state` matches an authorization Airlock itself started, and that state is
 * single use. It answers 404 while no provider opts in, so gateways that never use it expose
 * nothing new. It is registered in its own plugin scope, so it neither inherits nor alters the MCP
 * routes' auth, and it never runs on the management listener.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function oauthCallbackPlugin(
  app: FastifyInstance,
  opts: {
    router: OAuthCallbackRouter;
    /** Live check (survives hot reload): does any provider use `oauth_callback_mode: gateway`? */
    isEnabled: () => boolean;
  }
): Promise<void> {
  app.route({
    method: 'GET',
    url: OAUTH_CALLBACK_PATH,
    // A HEAD probe (link previewers, scanners) must not consume a single-use callback.
    exposeHeadRoute: false,
    handler: (request: FastifyRequest, reply: FastifyReply) => {
      if (!opts.isEnabled()) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const query = new URL(request.raw.url ?? '/', 'http://localhost').searchParams;
      const result = opts.router.handle(query);
      return reply.code(result.status).headers(OAUTH_CALLBACK_RESPONSE_HEADERS).send(result.html);
    },
  });
}
