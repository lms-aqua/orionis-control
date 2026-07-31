/**
 * Unauthenticated discovery + liveness.
 *
 * /meta is what the app calls during first-launch setup to decide whether it
 * can talk to this gateway at all. It deliberately exposes no internal
 * topology — only capability flags and the API contract version.
 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/envelope.ts';
import { API_VERSION, MIN_SUPPORTED_APP_BUILD, SERVER_VERSION } from '../version.ts';

export async function registerMetaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meta', async (req) => {
    const { config, orionis, adguard, push, oidc } = req.services;
    return ok(
      {
        product: 'Orionis Control',
        apiVersion: API_VERSION,
        serverVersion: SERVER_VERSION,
        minimumAppBuild: MIN_SUPPORTED_APP_BUILD,
        environment: config.env,
        authentication: {
          method: 'oidc-authorization-code-pkce',
          configured: oidc.configured,
          loginPath: '/api/mobile/v1/auth/login',
          tokenPath: '/api/mobile/v1/auth/token',
          allowedRedirectSchemes: config.allowedRedirectSchemes,
        },
        capabilities: {
          cameras: orionis.configured,
          events: orionis.configured,
          recordings: orionis.configured,
          streaming: orionis.configured,
          adguard: adguard.configured,
          push: push.configured,
        },
        // Surfaced so the app can render an honest "partially configured"
        // banner during setup rather than failing screen by screen.
        unconfigured: [
          orionis.configured ? null : 'orionis',
          adguard.configured ? null : 'adguard',
          push.configured ? null : 'push',
          oidc.configured ? null : 'authentication',
        ].filter((v): v is string => v !== null),
      },
      req.id,
    );
  });

  app.get('/health', async (req) => {
    const { db, startedAt } = req.services;
    let dbOk = true;
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    return ok(
      {
        status: dbOk ? 'healthy' : 'critical',
        uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        database: dbOk ? 'healthy' : 'critical',
        serverVersion: SERVER_VERSION,
      },
      req.id,
    );
  });
}
