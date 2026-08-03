/**
 * System health aggregation, approved recovery actions, and the dashboard.
 *
 * There is no arbitrary command execution here. Only actions on an explicit
 * allow-list can run, each gated by permission, confirmation and audit.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.ts';
import { ok } from '../lib/envelope.ts';
import { actorOf, requirePermission, withIdempotency } from '../http/context.ts';
import { SERVER_VERSION } from '../version.ts';

export type ServiceStatus = 'healthy' | 'warning' | 'critical' | 'offline' | 'unknown';

export interface ServiceHealth {
  id: string;
  name: string;
  status: ServiceStatus;
  message: string | null;
  latencyMs: number | null;
  version: string | null;
  checkedAt: string;
  /** What stops working in the app when this service is down. */
  impacts: string[];
}

/** The complete allow-list of operations the app may trigger. */
export const SYSTEM_ACTIONS = [
  {
    id: 'health.recheck',
    name: 'Run health check',
    description: 'Re-probes every configured service immediately.',
    disruptive: false,
    target: 'gateway',
  },
  {
    id: 'adguard.filters.reload',
    name: 'Reload AdGuard filters',
    description: 'Asks AdGuard Home to refresh its filter lists from source.',
    disruptive: false,
    target: 'adguard',
  },
  {
    id: 'cameras.reconnect',
    name: 'Refresh camera connections',
    description: 'Asks Orionis Guard to re-establish camera connections.',
    disruptive: true,
    target: 'orionis',
  },
  {
    id: 'gateway.cache.clear',
    name: 'Clear gateway cache',
    description: 'Drops cached discovery documents and expired session records.',
    disruptive: false,
    target: 'gateway',
  },
  {
    id: 'orionis.service.restart',
    name: 'Restart an Orionis service',
    description: 'Restarts a named Orionis service. Requires a serviceId.',
    disruptive: true,
    target: 'orionis',
  },
] as const;

export type SystemActionId = (typeof SYSTEM_ACTIONS)[number]['id'];

const ActionBody = z.object({
  actionId: z.enum(SYSTEM_ACTIONS.map((a) => a.id) as [SystemActionId, ...SystemActionId[]]),
  serviceId: z.string().max(64).optional(),
  reason: z.string().max(280).optional(),
});

interface HealthRequest {
  services: {
    config: {
      orionis: { configured: boolean };
      adguard: { configured: boolean };
      oidc: { configured: boolean };
    };
    orionis: { configured: boolean; listServiceHealth: () => Promise<unknown[]> };
    adguard: {
      configured: boolean;
      probe: () => Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
    };
    oidc: { configured: boolean; discover: (f?: boolean) => Promise<unknown> };
    push: { configured: boolean };
    db: { prepare: (sql: string) => { get: () => unknown } };
    startedAt: Date;
  };
}

interface HealthCacheEntry {
  value: ServiceHealth[] | null;
  expiresAt: number;
  inFlight: Promise<ServiceHealth[]> | null;
}

const HEALTH_CACHE_TTL_MS = 5_000;
const healthCache = new WeakMap<object, HealthCacheEntry>();

/** Probes everything configured; never throws, always returns a row per service. */
async function collectHealthUncached(req: HealthRequest): Promise<ServiceHealth[]> {
  const now = () => new Date().toISOString();
  const out: ServiceHealth[] = [];
  const s = req.services;

  // gateway + database
  let dbOk = true;
  const dbStart = Date.now();
  try {
    s.db.prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  out.push({
    id: 'mobile-api',
    name: 'Mobile API gateway',
    status: 'healthy',
    message: null,
    latencyMs: 0,
    version: SERVER_VERSION,
    checkedAt: now(),
    impacts: [],
  });
  out.push({
    id: 'database',
    name: 'Gateway database',
    status: dbOk ? 'healthy' : 'critical',
    message: dbOk
      ? null
      : 'The gateway database is not responding. Sign-in and auditing are affected.',
    latencyMs: Date.now() - dbStart,
    version: null,
    checkedAt: now(),
    impacts: dbOk ? [] : ['Sign-in', 'Audit log', 'Notification preferences'],
  });

  // Independent network probes run concurrently. A slow DNS server must not
  // delay the camera/identity result, and vice versa.
  const [authHealth, orionisHealth, adguardHealth] = await Promise.all([
    (async (): Promise<ServiceHealth> => {
      const started = Date.now();
      if (!s.oidc.configured) {
        return {
          id: 'authelia',
          name: 'Authelia',
          status: 'unknown',
          message: 'Not configured on this gateway.',
          latencyMs: null,
          version: null,
          checkedAt: now(),
          impacts: ['Sign-in'],
        };
      }
      try {
        await s.oidc.discover(true);
        return {
          id: 'authelia',
          name: 'Authelia',
          status: 'healthy',
          message: null,
          latencyMs: Date.now() - started,
          version: null,
          checkedAt: now(),
          impacts: [],
        };
      } catch (err) {
        return {
          id: 'authelia',
          name: 'Authelia',
          status: 'critical',
          message: err instanceof AppError ? err.message : 'The identity provider is unreachable.',
          latencyMs: Date.now() - started,
          version: null,
          checkedAt: now(),
          impacts: ['New sign-ins', 'Session renewal after expiry'],
        };
      }
    })(),
    (async (): Promise<ServiceHealth[]> => {
      try {
        const rows = (await s.orionis.listServiceHealth()) as {
          id: string;
          name: string;
          status: ServiceStatus;
          version: string | null;
          message: string | null;
          checkedAt: string;
        }[];
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
          message: row.message,
          latencyMs: null,
          version: row.version,
          checkedAt: row.checkedAt,
          impacts:
            row.status === 'healthy' ? [] : ['Live camera view', 'Camera events', 'Recordings'],
        }));
      } catch (err) {
        return [
          {
            id: 'orionis-api',
            name: 'Orionis Guard API',
            status: 'critical',
            message: err instanceof AppError ? err.message : 'Orionis Guard is unreachable.',
            latencyMs: null,
            version: null,
            checkedAt: now(),
            impacts: ['Live camera view', 'Camera events', 'Recordings'],
          },
        ];
      }
    })(),
    (async (): Promise<ServiceHealth> => {
      const probe = await s.adguard.probe();
      return {
        id: 'adguard',
        name: 'AdGuard Home',
        status: !s.adguard.configured ? 'unknown' : probe.ok ? 'healthy' : 'critical',
        message: !s.adguard.configured
          ? 'Not configured on this gateway.'
          : probe.ok
            ? null
            : `AdGuard Home did not respond (${probe.detail ?? 'unknown error'}).`,
        latencyMs: probe.latencyMs,
        version: null,
        checkedAt: now(),
        impacts: probe.ok ? [] : ['DNS statistics', 'Query log', 'Protection controls'],
      };
    })(),
  ]);
  out.push(authHealth, ...orionisHealth, adguardHealth);

  // push
  out.push({
    id: 'apns',
    name: 'Push notifications',
    status: s.push.configured ? 'healthy' : 'unknown',
    message: s.push.configured ? null : 'APNs credentials are not configured on this gateway.',
    latencyMs: null,
    version: null,
    checkedAt: now(),
    impacts: s.push.configured ? [] : ['Push notifications'],
  });

  return out;
}

/**
 * Shares a short health snapshot across dashboard/system callers and coalesces
 * concurrent probes. Manual rechecks bypass retained values, not active work.
 */
export async function collectHealth(req: HealthRequest, force = false): Promise<ServiceHealth[]> {
  const key = req.services as object;
  const current = healthCache.get(key);
  if (current?.inFlight) return current.inFlight;
  if (!force && current?.value && current.expiresAt > Date.now()) return current.value;

  const inFlight = collectHealthUncached(req);
  healthCache.set(key, {
    value: current?.value ?? null,
    expiresAt: current?.expiresAt ?? 0,
    inFlight,
  });
  try {
    const value = await inFlight;
    healthCache.set(key, {
      value,
      expiresAt: Date.now() + HEALTH_CACHE_TTL_MS,
      inFlight: null,
    });
    return value;
  } catch (error) {
    healthCache.delete(key);
    throw error;
  }
}

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /system/services -------------------------------------------------
  app.get('/system/services', { preHandler: requirePermission('system.view') }, async (req) => {
    const services = await collectHealth(req as never);
    const worst = services.reduce<ServiceStatus>((acc, s) => {
      const rank = { healthy: 0, unknown: 1, warning: 2, offline: 3, critical: 4 };
      return rank[s.status] > rank[acc] ? s.status : acc;
    }, 'healthy');

    return ok(
      {
        overall: worst,
        services,
        gateway: {
          version: SERVER_VERSION,
          uptimeSeconds: Math.floor((Date.now() - req.services.startedAt.getTime()) / 1000),
          environment: req.services.config.env,
        },
        checkedAt: new Date().toISOString(),
      },
      req.id,
    );
  });

  // --- GET /system/services/:serviceId --------------------------------------
  app.get<{ Params: { serviceId: string } }>(
    '/system/services/:serviceId',
    { preHandler: requirePermission('system.view') },
    async (req) => {
      const services = await collectHealth(req as never);
      const service = services.find((s) => s.id === req.params.serviceId);
      if (!service) throw AppError.notFound('That service');
      return ok(
        {
          ...service,
          availableActions: SYSTEM_ACTIONS.filter(
            (a) => a.target === service.id || a.target === 'gateway',
          ),
        },
        req.id,
      );
    },
  );

  // --- GET /system/actions --------------------------------------------------
  app.get('/system/actions', { preHandler: requirePermission('system.view') }, async (req) =>
    ok({ items: SYSTEM_ACTIONS }, req.id),
  );

  // --- POST /system/actions -------------------------------------------------
  app.post(
    '/system/actions',
    {
      preHandler: requirePermission('system.actions.run'),
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (req) => {
      const body = ActionBody.parse(req.body);
      const { orionis, adguard, sessions, audit } = req.services;
      const definition = SYSTEM_ACTIONS.find((a) => a.id === body.actionId)!;

      if (definition.disruptive && req.headers['x-confirm-disruptive'] !== 'true') {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${definition.name}" is disruptive and requires explicit confirmation.`,
          { requiresHeader: 'X-Confirm-Disruptive: true' },
        );
      }

      const endpoint = 'POST /system/actions';
      const { value, replayed } = await withIdempotency(req, endpoint, body, async () => {
        let result: { ok: boolean; message: string };

        switch (body.actionId) {
          case 'health.recheck': {
            const services = await collectHealth(req as never, true);
            const unhealthy = services.filter(
              (s) => s.status !== 'healthy' && s.status !== 'unknown',
            );
            result = {
              ok: true,
              message:
                unhealthy.length === 0
                  ? 'All configured services responded normally.'
                  : `${unhealthy.length} service(s) reported a problem: ${unhealthy.map((s) => s.name).join(', ')}.`,
            };
            break;
          }
          case 'adguard.filters.reload': {
            const refreshed = await adguard.refreshFilters(false);
            result = { ok: true, message: `${refreshed.updated} filter list(s) updated.` };
            break;
          }
          case 'gateway.cache.clear': {
            sessions.purgeExpired();
            result = { ok: true, message: 'Expired sessions, codes and caches were cleared.' };
            break;
          }
          case 'cameras.reconnect': {
            result = await orionis.runServiceAction('camera-manager', 'reconnect');
            break;
          }
          case 'orionis.service.restart': {
            if (!body.serviceId) {
              throw new AppError(
                'VALIDATION_FAILED',
                'A serviceId is required to restart a service.',
              );
            }
            result = await orionis.runServiceAction(body.serviceId, 'restart');
            break;
          }
        }

        audit.record({
          action: 'system.action.invoked',
          actor: actorOf(req),
          outcome: result.ok ? 'success' : 'failure',
          targetType: 'system_action',
          targetId: body.actionId,
          reason: body.reason ?? null,
          requestId: req.id,
          ip: req.ip,
          metadata: { serviceId: body.serviceId ?? null },
        });

        return { actionId: body.actionId, ...result, ranAt: new Date().toISOString() };
      });

      return ok({ ...value, replayed }, req.id);
    },
  );

  // --- GET /dashboard -------------------------------------------------------
  // One round trip for the home screen. Each section degrades independently:
  // a failing upstream yields a section-level error, not a blank dashboard.
  app.get('/dashboard', { preHandler: requirePermission('system.view') }, async (req) => {
    const { orionis, adguard, db } = req.services;

    const section = async <T>(load: () => Promise<T>) => {
      try {
        return { available: true as const, data: await load(), error: null };
      } catch (err) {
        const e = err instanceof AppError ? err : new AppError('INTERNAL_ERROR', 'Unavailable.');
        return {
          available: false as const,
          data: null,
          error: { code: e.code, message: e.message, recoverable: e.recoverable },
        };
      }
    };

    const [cameras, adguardStatus, adguardStats, storage, services] = await Promise.all([
      section(async () => {
        const list = await orionis.listCameras();
        return {
          total: list.length,
          online: list.filter((c) => c.health.status === 'online').length,
          offline: list.filter((c) => c.health.status === 'offline').length,
          degraded: list.filter((c) => c.health.status === 'degraded').length,
          recording: list.filter((c) => c.health.recording).length,
          streaming: list.filter((c) => c.health.streaming).length,
        };
      }),
      section(() => adguard.getStatus()),
      section(() => adguard.getStats('today')),
      section(() => orionis.getStorageStatus()),
      section(async () => {
        const all = await collectHealth(req as never);
        return {
          total: all.length,
          healthy: all.filter((s) => s.status === 'healthy').length,
          degraded: all.filter((s) => s.status === 'warning').length,
          failing: all.filter((s) => s.status === 'critical' || s.status === 'offline').length,
          unknown: all.filter((s) => s.status === 'unknown').length,
        };
      }),
    ]);

    const recentEvents = await section(async () => {
      const result = await orionis.listEvents({ limit: 10, offset: 0 });
      const eventIds = result.items.map((event) => event.id);
      const ackIds = new Set<string>();
      if (eventIds.length > 0) {
        const placeholders = eventIds.map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT event_id FROM event_acknowledgements WHERE event_id IN (${placeholders})`,
          )
          .all(...eventIds) as { event_id: string }[];
        for (const row of rows) ackIds.add(row.event_id);
      }
      return {
        items: result.items.map((e) => ({ ...e, acknowledged: ackIds.has(e.id) })),
        unacknowledged: result.items.filter((e) => !ackIds.has(e.id)).length,
      };
    });

    return ok(
      {
        cameras,
        events: recentEvents,
        adguard: { status: adguardStatus, stats: adguardStats },
        storage,
        services,
        generatedAt: new Date().toISOString(),
      },
      req.id,
    );
  });
}
