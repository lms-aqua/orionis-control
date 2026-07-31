/** Registered device sessions, push registration, preferences and the audit log. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.ts';
import { ok, paged } from '../lib/envelope.ts';
import { actorOf, requireAuth, requirePermission } from '../http/context.ts';
import { DEFAULT_PREFERENCES, NOTIFICATION_KINDS } from '../notifications/push.ts';

const RegisterBody = z.object({
  token: z.string().min(64).max(200),
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
  deviceName: z.string().max(128).optional(),
  deviceModel: z.string().max(128).optional(),
  osVersion: z.string().max(64).optional(),
  appVersion: z.string().max(64).optional(),
});

const PreferencesBody = z.object({
  enabled: z.boolean(),
  kinds: z.record(z.string(), z.boolean()).default({}),
  cameras: z.record(z.string(), z.boolean()).default({}),
  minimumSeverity: z.enum(['info', 'warning', 'critical']).default('info'),
  quietHours: z
    .object({
      enabled: z.boolean(),
      startMinute: z.number().int().min(0).max(1439),
      endMinute: z.number().int().min(0).max(1439),
    })
    .default(DEFAULT_PREFERENCES.quietHours),
  criticalBypassesQuietHours: z.boolean().default(true),
});

const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().max(64).optional(),
  actorId: z.string().max(128).optional(),
  since: z.string().datetime().optional(),
});

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /devices ---------------------------------------------------------
  app.get('/devices', { preHandler: requireAuth }, async (req) => {
    const principal = req.principal!;
    const sessions = req.services.sessions.listSessions(principal.userId);
    return ok(
      {
        items: sessions.map((s) => ({
          id: s.id,
          deviceId: s.deviceId,
          deviceName: s.deviceName,
          createdAt: s.createdAt,
          lastUsedAt: s.lastUsedAt,
          expiresAt: s.expiresAt,
          revoked: Boolean(s.revokedAt),
          current: s.id === principal.sessionId,
        })),
      },
      req.id,
    );
  });

  // --- GET /devices/current -------------------------------------------------
  app.get('/devices/current', { preHandler: requireAuth }, async (req) => {
    const principal = req.principal!;
    const session = req.services.sessions.getSession(principal.sessionId)!;
    return ok(
      {
        id: session.id,
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
        pushRegistered: Boolean(
          req.services.db
            .prepare('SELECT 1 AS x FROM push_devices WHERE user_id = ? AND device_id = ?')
            .get(principal.userId, principal.deviceId),
        ),
        pushConfigured: req.services.push.configured,
      },
      req.id,
    );
  });

  // --- DELETE /devices/:sessionId -------------------------------------------
  app.delete<{ Params: { sessionId: string } }>(
    '/devices/:sessionId',
    { preHandler: requireAuth },
    async (req) => {
      const principal = req.principal!;
      const target = req.services.sessions.getSession(req.params.sessionId);
      if (!target) throw AppError.notFound('That device session');

      // A user may always remove their own sessions; removing anyone else's
      // requires the device-management permission.
      if (target.userId !== principal.userId) {
        const { can } = await import('../auth/roles.ts');
        if (!can(principal.role, 'devices.manage')) {
          throw new AppError('INSUFFICIENT_ROLE', 'You may only remove your own devices.');
        }
      }

      req.services.sessions.revokeSession(target.id, 'removed_by_user');
      req.services.push.removeDevice(target.userId, target.deviceId);
      req.services.audit.record({
        action: 'device.removed',
        actor: actorOf(req),
        outcome: 'success',
        targetType: 'session',
        targetId: target.id,
        requestId: req.id,
        ip: req.ip,
      });
      return ok({ revoked: true }, req.id);
    },
  );

  // --- POST /devices/push ---------------------------------------------------
  app.post('/devices/push', { preHandler: requireAuth }, async (req) => {
    const body = RegisterBody.parse(req.body);
    const principal = req.principal!;
    const result = req.services.push.registerDevice({
      userId: principal.userId,
      sessionId: principal.sessionId,
      deviceId: principal.deviceId,
      token: body.token,
      environment: body.environment,
    });

    req.services.audit.record({
      action: 'device.registered',
      actor: actorOf(req),
      outcome: 'success',
      targetType: 'push_device',
      targetId: result.id,
      requestId: req.id,
      ip: req.ip,
      metadata: { environment: body.environment },
    });

    return ok(
      {
        registered: true,
        pushConfigured: result.pushConfigured,
        // Honest: the token is stored and will be used the moment APNs
        // credentials are supplied, but nothing will be delivered until then.
        note: result.pushConfigured
          ? null
          : 'APNs is not configured on this gateway, so no notifications will be delivered yet.',
      },
      req.id,
    );
  });

  // --- DELETE /devices/push -------------------------------------------------
  app.delete('/devices/push', { preHandler: requireAuth }, async (req) => {
    const principal = req.principal!;
    const removed = req.services.push.removeDevice(principal.userId, principal.deviceId);
    return ok({ removed }, req.id);
  });

  // --- GET /notifications/preferences ---------------------------------------
  app.get('/notifications/preferences', { preHandler: requireAuth }, async (req) => {
    const principal = req.principal!;
    return ok(
      {
        preferences: req.services.push.getPreferences(principal.userId, principal.deviceId),
        availableKinds: NOTIFICATION_KINDS,
        pushConfigured: req.services.push.configured,
      },
      req.id,
    );
  });

  // --- PUT /notifications/preferences ---------------------------------------
  app.put('/notifications/preferences', { preHandler: requireAuth }, async (req) => {
    const body = PreferencesBody.parse(req.body);
    const principal = req.principal!;

    const unknownKinds = Object.keys(body.kinds).filter(
      (k) => !(NOTIFICATION_KINDS as readonly string[]).includes(k),
    );
    if (unknownKinds.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'One or more notification kinds are not recognised.',
        {
          unknownKinds,
        },
      );
    }

    req.services.push.setPreferences(principal.userId, principal.deviceId, body);
    req.services.audit.record({
      action: 'notifications.preferences.updated',
      actor: actorOf(req),
      outcome: 'success',
      requestId: req.id,
      ip: req.ip,
      metadata: { enabled: body.enabled, quietHours: body.quietHours.enabled },
    });

    return ok({ preferences: body }, req.id);
  });

  // --- GET /audit -----------------------------------------------------------
  app.get('/audit', { preHandler: requirePermission('audit.view') }, async (req) => {
    const q = AuditQuery.parse(req.query);
    const result = req.services.audit.list(q);
    return paged(
      result.items,
      {
        total: result.total,
        limit: q.limit,
        offset: q.offset,
        hasMore: q.offset + result.items.length < result.total,
      },
      req.id,
    );
  });
}
