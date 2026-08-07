/**
 * Camera connections: the sources the gateway merges into one camera list.
 *
 * Administrator-only, and audited, for the same reason `infra` is: a connection
 * holds credentials for a system this gateway does not own, and its settings
 * decide what addresses the server will fetch. Both are privileges an operator
 * has no need of.
 *
 * Two rules shape the responses:
 *
 *   1. A stored credential never comes back out. `secretsSet` reports which
 *      keys are set and nothing else — not the value, not its length.
 *   2. A write returns the record as stored, so the app never has to guess what
 *      the server kept.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.ts';
import { ok } from '../lib/envelope.ts';
import { actorOf, requirePermission, withIdempotency } from '../http/context.ts';
import type { ConnectionRecord, ConnectionStore } from '../adapters/connections/store.ts';

const SettingsSchema = z.record(z.string().min(1).max(64), z.unknown());
/** Secret values are opaque strings; an empty string clears the stored one. */
const SecretsSchema = z.record(z.string().min(1).max(64), z.string().max(4096));

const CreateBody = z.object({
  provider: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  settings: SettingsSchema.optional(),
  secrets: SecretsSchema.optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const UpdateBody = z.object({
  name: z.string().min(1).max(80).optional(),
  settings: SettingsSchema.optional(),
  secrets: SecretsSchema.optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const CompleteAuthBody = z.object({
  challengeId: z.string().min(1).max(200),
  // Verification codes are short digit strings; anything else is not a code.
  code: z.string().min(3).max(12),
});

/** The store, or a typed explanation of why the feature is off. */
function storeOf(services: { connections: ConnectionStore | null }): ConnectionStore {
  if (!services.connections) {
    throw new AppError(
      'SERVICE_NOT_CONFIGURED',
      'Camera connections are not enabled on this gateway. Set CONNECTIONS_SECRET_KEY to turn them on.',
    );
  }
  return services.connections;
}

/** The shape the app sees: the record plus its last observed health. */
function present(store: ConnectionStore, record: ConnectionRecord): object {
  return { ...record, health: store.health(record.id) };
}

export async function registerConnectionRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /connections/providers -------------------------------------------
  // What can be added, and which fields each kind needs. The app renders its
  // "add connection" form from this rather than hard-coding a form per
  // provider, so a new provider appears in the app with no app release.
  app.get(
    '/connections/providers',
    { preHandler: requirePermission('connections.view') },
    async (req) => {
      const store = storeOf(req.services);
      return ok({ providers: store.providers() }, req.id);
    },
  );

  // --- GET /connections -----------------------------------------------------
  app.get('/connections', { preHandler: requirePermission('connections.view') }, async (req) => {
    const store = storeOf(req.services);
    return ok({ connections: store.list().map((c) => present(store, c)) }, req.id);
  });

  // --- POST /connections ----------------------------------------------------
  app.post('/connections', { preHandler: requirePermission('connections.manage') }, async (req) => {
    const body = CreateBody.parse(req.body ?? {});
    const store = storeOf(req.services);

    // Creating stores credentials and then probes an upstream, so it is slow
    // enough to be retried by an impatient hand. Name uniqueness already turns
    // a duplicate into a 409 rather than a second source, but an idempotency
    // key makes the retry return the original result instead of an error.
    const endpoint = 'POST /connections';
    const { value } = await withIdempotency(req, endpoint, body, async () => {
      const record = store.create({ ...body, createdBy: req.principal?.userId ?? null });

      req.services.audit.record({
        action: 'connection.created',
        actor: actorOf(req),
        outcome: 'success',
        targetType: 'connection',
        targetId: record.id,
        requestId: req.id,
        ip: req.ip,
        // Provider and name only: settings can carry an address, and secrets are
        // never eligible for the log at all.
        metadata: { provider: record.provider, name: record.name, slug: record.slug },
      });

      // Probed immediately so the operator sees whether it works, rather than
      // saving something broken and finding out at the camera wall.
      const health = await store.probe(record.id);
      return { ...present(store, store.get(record.id)), health };
    });

    return ok(value, req.id);
  });

  // --- GET /connections/:connectionId ---------------------------------------
  app.get<{ Params: { connectionId: string } }>(
    '/connections/:connectionId',
    { preHandler: requirePermission('connections.view') },
    async (req) => {
      const store = storeOf(req.services);
      return ok(present(store, store.get(req.params.connectionId)), req.id);
    },
  );

  // --- PATCH /connections/:connectionId -------------------------------------
  app.patch<{ Params: { connectionId: string } }>(
    '/connections/:connectionId',
    { preHandler: requirePermission('connections.manage') },
    async (req) => {
      const body = UpdateBody.parse(req.body ?? {});
      const store = storeOf(req.services);
      const record = store.update(req.params.connectionId, body);

      req.services.audit.record({
        action: 'connection.updated',
        actor: actorOf(req),
        outcome: 'success',
        targetType: 'connection',
        targetId: record.id,
        requestId: req.id,
        ip: req.ip,
        metadata: {
          name: record.name,
          enabled: record.enabled,
          // Which credentials were replaced is worth knowing; their values are
          // not, and never enter this object.
          secretsChanged: Object.keys(body.secrets ?? {}),
        },
      });

      return ok(present(store, record), req.id);
    },
  );

  // --- DELETE /connections/:connectionId ------------------------------------
  app.delete<{ Params: { connectionId: string } }>(
    '/connections/:connectionId',
    { preHandler: requirePermission('connections.manage') },
    async (req) => {
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);

      // Removal deletes stored credentials and takes this source's cameras off
      // the wall. Nothing on the camera system itself changes, but the local
      // loss is real and unrecoverable — so it joins the same explicit
      // confirmation convention as pausing DNS protection and restarting a
      // camera, rather than relying on the app to ask nicely.
      if (req.headers['x-confirm-disruptive'] !== 'true') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Removing "${record.name}" deletes its stored credentials and removes its cameras from the app. Confirm to proceed.`,
          { requiresHeader: 'X-Confirm-Disruptive: true' },
        );
      }

      store.remove(record.id);

      req.services.audit.record({
        action: 'connection.removed',
        actor: actorOf(req),
        outcome: 'success',
        targetType: 'connection',
        targetId: record.id,
        requestId: req.id,
        ip: req.ip,
        metadata: { provider: record.provider, name: record.name },
      });

      return ok({ removed: true, id: record.id }, req.id);
    },
  );

  // --- POST /connections/:connectionId/probe --------------------------------
  app.post<{ Params: { connectionId: string } }>(
    '/connections/:connectionId/probe',
    { preHandler: requirePermission('connections.view') },
    async (req) => {
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);
      // Deliberately not the cached read: asking for a probe means asking for a
      // fresh answer.
      const health = await store.probe(record.id);

      req.services.audit.record({
        action: 'connection.probed',
        actor: actorOf(req),
        outcome: health.status === 'healthy' ? 'success' : 'failure',
        targetType: 'connection',
        targetId: record.id,
        requestId: req.id,
        ip: req.ip,
        metadata: { status: health.status },
      });

      return ok({ health }, req.id);
    },
  );

  // --- POST /connections/:connectionId/auth/begin ---------------------------
  // Upstreams that cannot be authenticated by configuration alone. Blink accepts
  // the credentials, then sends a code out of band; the response says which of
  // those two happened.
  app.post<{ Params: { connectionId: string } }>(
    '/connections/:connectionId/auth/begin',
    { preHandler: requirePermission('connections.manage') },
    async (req) => {
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);
      const result = await store.beginAuth(record.id);

      req.services.audit.record({
        action: 'connection.auth.started',
        actor: actorOf(req),
        outcome: result.status === 'failed' ? 'failure' : 'success',
        targetType: 'connection',
        targetId: record.id,
        requestId: req.id,
        ip: req.ip,
        metadata: { provider: record.provider, result: result.status },
      });

      return ok(result, req.id);
    },
  );

  // --- POST /connections/:connectionId/auth/complete ------------------------
  app.post<{ Params: { connectionId: string } }>(
    '/connections/:connectionId/auth/complete',
    { preHandler: requirePermission('connections.manage') },
    async (req) => {
      const body = CompleteAuthBody.parse(req.body ?? {});
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);
      const result = await store.completeAuth(record.id, body.challengeId, body.code);

      req.services.audit.record({
        action: 'connection.auth.completed',
        actor: actorOf(req),
        outcome: result.status === 'complete' ? 'success' : 'failure',
        targetType: 'connection',
        targetId: record.id,
        requestId: req.id,
        ip: req.ip,
        // The code itself is a credential for the duration of its life and is
        // never recorded.
        metadata: { provider: record.provider, result: result.status },
      });

      if (result.status === 'complete') {
        // A successful sign-in usually makes the source reachable; refresh the
        // health so the screen the user returns to is already correct.
        await store.probe(record.id);
      }
      return ok(result, req.id);
    },
  );
}
