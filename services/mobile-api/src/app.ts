/**
 * Fastify application assembly: security headers, CORS, rate limiting, request
 * IDs, structured logging with redaction, the versioned route prefix and the
 * single error handler that converts everything into the response envelope.
 */
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { randomId } from './lib/crypto.ts';
import { AppError } from './lib/errors.ts';
import { fail, failCode } from './lib/envelope.ts';
import { redact } from './lib/redact.ts';
import type { AppServices } from './services.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCameraRoutes } from './routes/cameras.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerInfraRoutes } from './routes/infra.ts';
import { registerAdGuardRoutes } from './routes/adguard.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerDeviceRoutes } from './routes/devices.ts';
import { registerDiagnosticRoutes } from './routes/diagnostics.ts';
import { getAltstoreSource } from './lib/altstore-source.ts';
import { API_VERSION } from './version.ts';

export const API_PREFIX = '/api/mobile/v1';

export async function buildApp(services: AppServices): Promise<FastifyInstance> {
  const { config } = services;

  const app = Fastify({
    genReqId: () => randomId('req'),
    trustProxy: true,
    // Fastify's automatic per-request logging is replaced by the onResponse
    // hook below, which adds the principal and drops query strings.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    logger: {
      level: config.logLevel,
      // Every log line passes through the redactor: no token, cookie or
      // credential can reach the log sink even from an unexpected field.
      formatters: {
        log: (obj) => redact(obj) as Record<string, unknown>,
      },
      serializers: {
        req: (req) => ({ method: req.method, url: String(req.url).split('?')[0], id: req.id }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
  });

  app.decorateRequest('services', null as unknown as AppServices);
  app.decorateRequest('principal', undefined);
  app.addHook('onRequest', async (req) => {
    req.services = services;
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // JSON API; no HTML is served
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  // The iOS client is not a browser origin, so CORS stays closed by default.
  await app.register(cors, { origin: false });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    keyGenerator: (req) => {
      const principal = req.principal;
      return principal ? `u:${principal.userId}` : `ip:${req.ip}`;
    },
    errorResponseBuilder: (req, context) =>
      failCode(
        'RATE_LIMITED',
        `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
        req.id,
        { limit: context.max },
      ),
  });

  // --- request/response logging (paths only; query strings are dropped) -----
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({
      req: { method: req.method, url: req.url.split('?')[0], id: req.id },
      res: { statusCode: reply.statusCode },
      durationMs: Math.round(reply.elapsedTime),
      userId: req.principal?.userId ?? null,
    });
  });

  // --- version negotiation --------------------------------------------------
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-api-version', API_VERSION);
    return payload;
  });

  // --- the one error handler ------------------------------------------------
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      if (error.status >= 500) {
        req.log.error({ err: error, code: error.code }, 'request failed');
      } else {
        req.log.warn({ code: error.code }, 'request rejected');
      }
      return reply.status(error.status).send(fail(error, req.id));
    }

    if (error instanceof ZodError) {
      return reply.status(400).send(
        failCode('VALIDATION_FAILED', 'The request body or query string is invalid.', req.id, {
          fields: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        }),
      );
    }

    // Fastify's own validation / parse errors.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply
        .status(statusCode)
        .send(failCode('VALIDATION_FAILED', 'The request could not be processed.', req.id));
    }

    // Anything unexpected: log fully (redacted), return nothing revealing.
    req.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send(
        failCode(
          'INTERNAL_ERROR',
          'The gateway encountered an unexpected error. The failure was logged with this request ID.',
          req.id,
        ),
      );
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send(failCode('NOT_FOUND', 'No such endpoint on this gateway.', req.id)),
  );

  // --- routes ---------------------------------------------------------------
  await app.register(
    async (scope) => {
      await registerMetaRoutes(scope);
      await registerAuthRoutes(scope);
      await registerCameraRoutes(scope);
      await registerEventRoutes(scope);
      await registerInfraRoutes(scope);
      await registerAdGuardRoutes(scope);
      await registerSystemRoutes(scope);
      await registerDeviceRoutes(scope);
      await registerDiagnosticRoutes(scope);
    },
    { prefix: API_PREFIX },
  );

  // Unversioned liveness probe for orchestrators.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Fronts the AltStore/SideStore source so a client never catches the GitHub
  // release asset mid-upload (which fails as an unreadable-format error). Public
  // by design — it is app-install metadata, not user data.
  app.get('/altstore/source.json', async (_req, reply) => {
    try {
      const body = await getAltstoreSource();
      return reply.type('application/json').header('cache-control', 'no-cache').send(body);
    } catch {
      return reply.status(503).send({ error: 'The app source is temporarily unavailable.' });
    }
  });

  return app;
}
