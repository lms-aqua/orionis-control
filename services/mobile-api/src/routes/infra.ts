/**
 * Caddy and Authelia management.
 *
 * Everything here is administrator-only and audited, because the blast radius is
 * unlike the rest of the gateway: a bad Caddy config takes every site on the host
 * offline — unrelated client sites included — and a bad Authelia config locks
 * every user out of every protected service.
 *
 * Two rules shape the design:
 *
 *   1. The gateway never edits Caddy or Authelia directly. caddymanager already
 *      holds that privilege; this proxies to it. Editing here would need the
 *      Docker socket or Authelia's secrets, both refused by ADR 0003/0005.
 *   2. A change may not remove the path the app depends on. `infra-guards`
 *      enforces that, because if the gateway or SSO goes down, the app cannot be
 *      used to put it back.
 *
 * Restarting Authelia is deliberately *not* done from here. It signs out every SSO
 * user, including the session making the request, so it is queued for the
 * host-side applier and reported as pending.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.ts';
import { ok } from '../lib/envelope.ts';
import { actorOf, requirePermission } from '../http/context.ts';
import {
  guardAutheliaConfig,
  guardCaddyConfig,
  summariseCaddyChange,
} from '../lib/infra-guards.ts';
import { requestAutheliaRestart, readAutheliaRestart } from '../lib/infra-control.ts';
import type { AuditInput } from '../audit/audit.ts';

const CaddyConfigBody = z.object({
  serverId: z.string().min(1).max(64),
  configId: z.string().min(1).max(64),
  content: z.string().min(1).max(1_000_000),
  /** Required when the change removes a hostname that is currently served. */
  confirmRemovingHosts: z.boolean().optional(),
});

const AutheliaConfigBody = z.object({
  content: z.string().min(1).max(1_000_000),
});

const PasswordBody = z.object({
  // Long enough to be worth setting from a phone at all.
  password: z.string().min(12).max(256),
});

const RestoreBody = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    // Anchored: the name lands in a filesystem call on the far side.
    .regex(/^[A-Za-z0-9._-]+$/, 'That is not a valid backup name.'),
});

/** The gateway's own hostname, which no change may cut off. */
function gatewayHost(publicBaseUrl: string): string {
  try {
    return new URL(publicBaseUrl).hostname;
  } catch {
    return '';
  }
}

export async function registerInfraRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /infra/status ----------------------------------------------------
  app.get('/infra/status', { preHandler: requirePermission('infra.view') }, async (req) => {
    const { infra, config } = req.services;
    if (!infra.configured) {
      throw new AppError(
        'SERVICE_NOT_CONFIGURED',
        'Infrastructure management is not configured on this gateway.',
      );
    }

    // Each side is reported independently: one being unreachable should not hide
    // the state of the other.
    const [caddy, authelia, restart] = await Promise.all([
      infra.caddyStatus().catch((error: unknown) => ({ error: describe(error) })),
      infra.autheliaRuntime().catch((error: unknown) => ({ error: describe(error) })),
      readAutheliaRestart(config.orionis.retentionDir),
    ]);

    return ok({ caddy, authelia, autheliaRestart: restart }, req.id);
  });

  // --- GET /infra/caddy/config ----------------------------------------------
  app.get<{ Querystring: { serverId?: string } }>(
    '/infra/caddy/config',
    { preHandler: requirePermission('infra.view') },
    async (req) => {
      const { infra } = req.services;
      const serverId = req.query.serverId ?? (await firstCaddyServerId(req.services));
      return ok({ serverId, ...(await infra.caddyCurrentConfig(serverId)) }, req.id);
    },
  );

  // --- PUT /infra/caddy/config ----------------------------------------------
  app.put('/infra/caddy/config', { preHandler: requirePermission('infra.manage') }, async (req) => {
    const body = CaddyConfigBody.parse(req.body ?? {});
    const { infra, config, audit } = req.services;

    // 1. Refuse anything that would disconnect the app from the server. This runs
    //    before the config is sent anywhere.
    guardCaddyConfig({
      content: body.content,
      gatewayHost: gatewayHost(config.publicBaseUrl),
      gatewayUpstream: config.infra.gatewayUpstream,
    });

    // 2. Describe what the change does to other sites, and require that removals
    //    were intended. Taking a client site offline should never be a side effect.
    const current = await infra.caddyCurrentConfig(body.serverId);
    const summary = summariseCaddyChange(current.raw, body.content);
    if (summary.removesLiveHosts && body.confirmRemovingHosts !== true) {
      // Matches the convention already used for disruptive camera controls.
      throw new AppError(
        'VALIDATION_FAILED',
        `This change removes ${summary.removedHosts.length} site(s) that are currently served: ` +
          `${summary.removedHosts.join(', ')}. Confirm to apply it.`,
        { removedHosts: summary.removedHosts, addedHosts: summary.addedHosts },
      );
    }

    // 3. caddymanager keeps its own backup and validates on apply; a rejected
    //    config surfaces as a typed error rather than a broken server.
    await auditMutation(
      audit,
      {
        action: 'infra.caddy.config_applied',
        actor: actorOf(req),
        targetType: 'caddy',
        targetId: body.serverId,
        requestId: req.id,
        ip: req.ip,
        metadata: {
          removedHosts: summary.removedHosts,
          addedHosts: summary.addedHosts,
          bytes: body.content.length,
        },
      },
      () => infra.caddyApplyConfig(body.configId, body.content),
    );
    return ok({ applied: true, ...summary }, req.id);
  });

  // --- GET /infra/authelia/config -------------------------------------------
  app.get('/infra/authelia/config', { preHandler: requirePermission('infra.view') }, async (req) =>
    ok(await req.services.infra.autheliaConfig(), req.id),
  );

  // --- PUT /infra/authelia/config -------------------------------------------
  app.put(
    '/infra/authelia/config',
    { preHandler: requirePermission('infra.manage') },
    async (req) => {
      const body = AutheliaConfigBody.parse(req.body ?? {});
      const { infra, config, audit } = req.services;

      // Refuse a config that would stop anyone signing in -- including whoever
      // would need to sign in to undo it.
      guardAutheliaConfig({
        content: body.content,
        oidcClientId: config.oidc.clientId,
      });

      // Then let Authelia's own validator have the final say, before anything is
      // written.
      const validation = await infra.autheliaValidate(body.content);
      if (!validation.valid) {
        throw new AppError(
          'VALIDATION_FAILED',
          validation.message ?? 'Authelia rejected this configuration.',
        );
      }

      await auditMutation(
        audit,
        {
          action: 'infra.authelia.config_applied',
          actor: actorOf(req),
          targetType: 'authelia',
          targetId: 'configuration',
          requestId: req.id,
          ip: req.ip,
          metadata: { bytes: body.content.length },
        },
        () => infra.autheliaApply(body.content),
      );

      // Applying writes the file; Authelia only reads it at start. Say so rather
      // than letting the change look live when it is not.
      return ok(
        {
          applied: true,
          activated: false,
          message:
            'Saved. Authelia keeps running its previous configuration until it is restarted.',
        },
        req.id,
      );
    },
  );

  // --- GET /infra/authelia/users --------------------------------------------
  app.get('/infra/authelia/users', { preHandler: requirePermission('infra.view') }, async (req) =>
    ok({ items: await req.services.infra.autheliaUsers() }, req.id),
  );

  // --- PUT /infra/authelia/users/:username/password -------------------------
  app.put<{ Params: { username: string } }>(
    '/infra/authelia/users/:username/password',
    { preHandler: requirePermission('infra.manage') },
    async (req) => {
      const body = PasswordBody.parse(req.body ?? {});
      const { infra, audit } = req.services;
      const username = req.params.username;

      await auditMutation(
        audit,
        {
          action: 'infra.authelia.password_reset',
          actor: actorOf(req),
          targetType: 'authelia_user',
          targetId: username,
          requestId: req.id,
          ip: req.ip,
          // The password itself is never recorded, only that it changed.
          metadata: { username },
        },
        () => infra.autheliaSetPassword(username, body.password),
      );
      return ok({ updated: true, username }, req.id);
    },
  );

  // --- GET /infra/authelia/backups ------------------------------------------
  app.get('/infra/authelia/backups', { preHandler: requirePermission('infra.view') }, async (req) =>
    ok({ items: await req.services.infra.autheliaBackups() }, req.id),
  );

  // --- POST /infra/authelia/backups/restore ---------------------------------
  app.post(
    '/infra/authelia/backups/restore',
    { preHandler: requirePermission('infra.manage') },
    async (req) => {
      const body = RestoreBody.parse(req.body ?? {});
      const { infra, audit } = req.services;

      await auditMutation(
        audit,
        {
          action: 'infra.authelia.backup_restored',
          actor: actorOf(req),
          targetType: 'authelia',
          targetId: body.name,
          requestId: req.id,
          ip: req.ip,
          metadata: { backup: body.name },
        },
        () => infra.autheliaRestoreBackup(body.name),
      );
      return ok(
        {
          restored: true,
          activated: false,
          message: 'Restored. Authelia keeps running its previous configuration until restarted.',
        },
        req.id,
      );
    },
  );

  // --- POST /infra/authelia/restart -----------------------------------------
  // Queued, not performed. Restarting Authelia signs out every SSO user across
  // every protected site -- including the session making this request -- so it is
  // handed to the host-side applier and reported as pending. The gateway also has
  // no way to restart a container by design.
  app.post(
    '/infra/authelia/restart',
    { preHandler: requirePermission('infra.manage') },
    async (req) => {
      const { config, audit } = req.services;
      const principal = req.principal!;

      const state = await requestAutheliaRestart(config.orionis.retentionDir, principal.username);

      audit.record({
        action: 'infra.authelia.restart_requested',
        actor: actorOf(req),
        outcome: 'success',
        targetType: 'authelia',
        targetId: 'runtime',
        requestId: req.id,
        ip: req.ip,
        metadata: { requestedAt: state.requestedAt },
      });

      return ok(
        {
          ...state,
          message:
            'Restart queued. Every signed-in user, including you, will be signed out when it runs.',
        },
        req.id,
      );
    },
  );
}

/** First known Caddy server, so the app does not have to know its id. */
async function firstCaddyServerId(services: {
  infra: { caddyStatus: () => Promise<{ servers: { id: string }[] }> };
}): Promise<string> {
  const status = await services.infra.caddyStatus();
  const first = status.servers[0];
  if (!first) throw new AppError('NOT_FOUND', 'No Caddy server is registered.');
  return first.id;
}

/** Upstream failures are reported per-section rather than failing the whole page. */
function describe(error: unknown): string {
  return error instanceof AppError ? error.message : 'This service could not be reached.';
}

/**
 * Records exactly what an infrastructure mutation actually did.
 *
 * These operations cross a process boundary and can fail after validation. The
 * audit trail must therefore be written after the awaited result, while failures
 * still receive their own record before the original error is rethrown.
 */
export async function auditMutation(
  audit: { record(input: AuditInput): unknown },
  input: Omit<AuditInput, 'outcome' | 'reason'>,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
    audit.record({ ...input, outcome: 'success' });
  } catch (error) {
    audit.record({ ...input, outcome: 'failure', reason: describe(error) });
    throw error;
  }
}
