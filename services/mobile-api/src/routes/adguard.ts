/**
 * AdGuard Home management.
 *
 * Protection changes are the most consequential thing this app can do, so they
 * are: permission-gated, explicitly confirmed, duration-bounded, recorded with
 * an attributable override row, and audited.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.ts';
import { ok, paged } from '../lib/envelope.ts';
import { randomId } from '../lib/crypto.ts';
import { actorOf, requirePermission, withIdempotency } from '../http/context.ts';
import { validateRule } from '../adapters/adguard/http.ts';
import type { TimeRange } from '../adapters/adguard/types.ts';

const StatsQuery = z.object({
  range: z.enum(['hour', 'today', 'day', 'week', 'month']).default('today'),
});

const QueryLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  olderThan: z.string().optional(),
  search: z.string().max(253).optional(),
  status: z.enum(['all', 'blocked', 'allowed']).default('all'),
  client: z.string().max(128).optional(),
});

const ProtectionBody = z.object({
  enabled: z.boolean(),
  durationSeconds: z.number().int().min(60).max(86_400).nullable().optional(),
  until: z.string().datetime().nullable().optional(),
  reason: z.string().max(280).nullable().optional(),
});

const RuleBody = z.object({
  rule: z.string().min(1).max(512),
  kind: z.enum(['allow', 'block']),
});

const RuleDeleteBody = z.object({ rule: z.string().min(1).max(512) });

const RefreshBody = z.object({ whitelist: z.boolean().default(false) });

export async function registerAdGuardRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /adguard/status --------------------------------------------------
  app.get('/adguard/status', { preHandler: requirePermission('adguard.view') }, async (req) => {
    const { adguard, db } = req.services;
    const status = await adguard.getStatus();

    // Attribution for a currently-paused protection state.
    const active = db
      .prepare(
        'SELECT * FROM protection_overrides WHERE restored_at IS NULL ORDER BY disabled_at DESC LIMIT 1',
      )
      .get() as Record<string, unknown> | undefined;

    return ok(
      {
        ...status,
        override:
          !status.protectionEnabled && active
            ? {
                id: String(active.id),
                disabledBy: String(active.actor_name),
                disabledAt: String(active.disabled_at),
                resumeAt: (active.resume_at as string) ?? null,
                reason: (active.reason as string) ?? null,
              }
            : null,
      },
      req.id,
    );
  });

  // --- GET /adguard/stats ---------------------------------------------------
  app.get('/adguard/stats', { preHandler: requirePermission('adguard.view') }, async (req) => {
    const q = StatsQuery.parse(req.query);
    return ok(await req.services.adguard.getStats(q.range as TimeRange), req.id);
  });

  // --- GET /adguard/query-log -----------------------------------------------
  app.get('/adguard/query-log', { preHandler: requirePermission('adguard.view') }, async (req) => {
    const q = QueryLogQuery.parse(req.query);
    const result = await req.services.adguard.getQueryLog({
      limit: q.limit,
      olderThan: q.olderThan,
      search: q.search,
      status: q.status,
    });

    // AdGuard has no server-side client filter on the query log, so it is
    // applied here rather than pretending the upstream did it.
    const items = q.client
      ? result.items.filter((i) => i.client === q.client || i.clientName === q.client)
      : result.items;

    return paged(
      items,
      { total: null, limit: q.limit, offset: 0, hasMore: result.items.length === q.limit },
      req.id,
    );
  });

  // --- GET /adguard/clients -------------------------------------------------
  app.get('/adguard/clients', { preHandler: requirePermission('adguard.view') }, async (req) => {
    const clients = await req.services.adguard.listClients();
    return ok({ items: clients, total: clients.length }, req.id);
  });

  // --- GET /adguard/filters -------------------------------------------------
  app.get('/adguard/filters', { preHandler: requirePermission('adguard.view') }, async (req) => {
    const filters = await req.services.adguard.listFilters();
    return ok({ items: filters, total: filters.length }, req.id);
  });

  // --- GET /adguard/rules ---------------------------------------------------
  app.get('/adguard/rules', { preHandler: requirePermission('adguard.view') }, async (req) =>
    ok(await req.services.adguard.getCustomRules(), req.id),
  );

  // --- POST /adguard/rules --------------------------------------------------
  app.post(
    '/adguard/rules',
    {
      preHandler: requirePermission('adguard.rules.write'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = RuleBody.parse(req.body);
      const { adguard, audit } = req.services;

      // Normalise before validating so "example.com" becomes a real rule.
      const raw = body.rule.trim();
      const candidate =
        body.kind === 'allow'
          ? raw.startsWith('@@')
            ? raw
            : `@@||${raw.replace(/^\|\|/, '').replace(/\^$/, '')}^`
          : raw.startsWith('@@')
            ? raw
            : raw.startsWith('||') || raw.includes(' ') || raw.startsWith('/')
              ? raw
              : `||${raw}^`;

      const validation = validateRule(candidate);
      if (!validation.ok) {
        throw new AppError('RULE_INVALID', validation.reason, { rule: candidate });
      }

      const endpoint = 'POST /adguard/rules';
      const { value, replayed } = await withIdempotency(req, endpoint, body, async () => {
        const current = await adguard.getCustomRules();
        if (current.rules.some((r) => r.trim() === validation.normalised)) {
          throw new AppError('RULE_DUPLICATE', 'That rule already exists.', {
            rule: validation.normalised,
          });
        }
        const next = [...current.rules, validation.normalised];
        await adguard.setCustomRules(next);

        audit.record({
          action: 'adguard.rule.added',
          actor: actorOf(req),
          outcome: 'success',
          targetType: 'adguard_rule',
          targetId: validation.normalised,
          requestId: req.id,
          ip: req.ip,
          metadata: { kind: body.kind, ruleCount: next.length },
        });

        return { rule: validation.normalised, ruleCount: next.length };
      });

      return ok({ ...value, replayed }, req.id);
    },
  );

  // --- DELETE /adguard/rules ------------------------------------------------
  app.delete(
    '/adguard/rules',
    { preHandler: requirePermission('adguard.rules.write') },
    async (req) => {
      const body = RuleDeleteBody.parse(req.body);
      const { adguard, audit } = req.services;
      const target = body.rule.trim();

      const current = await adguard.getCustomRules();
      if (!current.rules.some((r) => r.trim() === target)) {
        throw AppError.notFound('That rule');
      }
      const next = current.rules.filter((r) => r.trim() !== target);
      await adguard.setCustomRules(next);

      audit.record({
        action: 'adguard.rule.removed',
        actor: actorOf(req),
        outcome: 'success',
        targetType: 'adguard_rule',
        targetId: target,
        requestId: req.id,
        ip: req.ip,
        metadata: { ruleCount: next.length },
      });

      return ok({ removed: target, ruleCount: next.length }, req.id);
    },
  );

  // --- POST /adguard/filters/refresh ----------------------------------------
  app.post(
    '/adguard/filters/refresh',
    {
      preHandler: requirePermission('adguard.filters.write'),
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    },
    async (req) => {
      const body = RefreshBody.parse(req.body ?? {});
      const result = await req.services.adguard.refreshFilters(body.whitelist);
      req.services.audit.record({
        action: 'adguard.filter.refreshed',
        actor: actorOf(req),
        outcome: 'success',
        requestId: req.id,
        ip: req.ip,
        metadata: { whitelist: body.whitelist, updated: result.updated },
      });
      return ok(result, req.id);
    },
  );

  // --- POST /adguard/protection ---------------------------------------------
  app.post(
    '/adguard/protection',
    {
      preHandler: requirePermission('adguard.protection.pause'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = ProtectionBody.parse(req.body);
      const { adguard, audit, db } = req.services;
      const principal = req.principal!;

      if (req.headers['x-confirm-disruptive'] !== 'true') {
        throw new AppError(
          'VALIDATION_FAILED',
          'Changing DNS protection requires explicit confirmation.',
          { requiresHeader: 'X-Confirm-Disruptive: true' },
        );
      }

      // Resolve "until" into a duration; a pause must always be bounded so a
      // forgotten toggle cannot leave the network unprotected indefinitely.
      let durationSeconds = body.durationSeconds ?? null;
      if (!body.enabled) {
        if (body.until) {
          const ms = new Date(body.until).getTime() - Date.now();
          if (ms <= 0) {
            throw new AppError('VALIDATION_FAILED', 'The resume time is in the past.');
          }
          durationSeconds = Math.min(86_400, Math.ceil(ms / 1000));
        }
        if (!durationSeconds) {
          throw new AppError(
            'VALIDATION_FAILED',
            'Disabling protection requires a duration or a resume time. Indefinite pauses are not permitted.',
          );
        }
      }

      const endpoint = 'POST /adguard/protection';
      const { value, replayed } = await withIdempotency(req, endpoint, body, async () => {
        const status = await adguard.setProtection({
          enabled: body.enabled,
          durationSeconds,
          reason: body.reason ?? null,
        });

        const now = new Date().toISOString();
        if (!body.enabled) {
          db.prepare(
            `INSERT INTO protection_overrides (id, actor_id, actor_name, disabled_at, resume_at, reason)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            randomId('pro'),
            principal.userId,
            principal.username,
            now,
            durationSeconds ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null,
            body.reason ?? null,
          );
        } else {
          db.prepare(
            'UPDATE protection_overrides SET restored_at = ?, restored_by = ? WHERE restored_at IS NULL',
          ).run(now, principal.username);
        }

        audit.record({
          action: body.enabled ? 'adguard.protection.enabled' : 'adguard.protection.disabled',
          actor: actorOf(req),
          outcome: 'success',
          targetType: 'adguard',
          targetId: 'protection',
          reason: body.reason ?? null,
          requestId: req.id,
          ip: req.ip,
          metadata: { durationSeconds },
        });

        return status;
      });

      return ok({ ...value, replayed }, req.id);
    },
  );
}
