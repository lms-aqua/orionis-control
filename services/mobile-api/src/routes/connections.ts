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

/**
 * The shape the app sees: the record, its last observed health, and — when one
 * exists — the state of the bridge the gateway asked the host to run.
 *
 * `provisioning` is read from the row rather than reconciled here: a list of
 * ten connections must not become ten filesystem reads. The dedicated
 * provisioning route reconciles, and that is the one the app polls while a
 * bridge is being created.
 */
function present(store: ConnectionStore, record: ConnectionRecord): object {
  return {
    ...record,
    health: store.health(record.id),
    provisioning: store.provisioning(record.id),
  };
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
      return ok(
        {
          providers: store.providers(),
          // Whether this deployment can stand a bridge up at all. Without it the
          // app would offer "Set up automatically" on a gateway that has no
          // applier behind it, and the button would only ever fail.
          provisioningAvailable: store.provisioningAvailable,
        },
        req.id,
      );
    },
  );

  // --- GET /connections -----------------------------------------------------
  app.get('/connections', { preHandler: requirePermission('connections.view') }, async (req) => {
    const store = storeOf(req.services);
    return ok({ connections: store.list().map((c) => present(store, c)) }, req.id);
  });

  // --- POST /connections ----------------------------------------------------
  app.post(
    '/connections',
    {
      preHandler: requirePermission('connections.manage'),
      // Each create ends in a probe of a third-party address, so this route can
      // make the gateway generate outbound traffic. Bounded per principal.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
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
    },
  );

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
  app.delete<{ Params: { connectionId: string }; Querystring: { keepBridge?: string } }>(
    '/connections/:connectionId',
    { preHandler: requirePermission('connections.manage') },
    async (req) => {
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);
      const bridge = store.provisioning(record.id);
      // A bridge Orionis started exists only to serve this connection, so
      // leaving it running after the connection is gone leaves a container
      // nobody can see holding a session against someone's camera account.
      // Stopping it is the default; `?keepBridge=true` is for the case where it
      // is being re-pointed rather than retired.
      const keepBridge = req.query.keepBridge === 'true';

      // Removal deletes stored credentials and takes this source's cameras off
      // the wall. Nothing on the camera system itself changes, but the local
      // loss is real and unrecoverable — so it joins the same explicit
      // confirmation convention as pausing DNS protection and restarting a
      // camera, rather than relying on the app to ask nicely.
      if (req.headers['x-confirm-disruptive'] !== 'true') {
        throw new AppError(
          'VALIDATION_FAILED',
          bridge && !keepBridge
            ? `Removing "${record.name}" deletes its stored credentials, removes its cameras from the app, and stops the bridge Orionis started for it. Confirm to proceed.`
            : `Removing "${record.name}" deletes its stored credentials and removes its cameras from the app. Confirm to proceed.`,
          { requiresHeader: 'X-Confirm-Disruptive: true' },
        );
      }

      // Queued before the row goes: the request needs the template and instance
      // name that only the provisioning record holds, and deleting the
      // connection cascades that away.
      const teardown =
        bridge && !keepBridge
          ? await store.requestTeardown(record.id, req.principal?.userId ?? null)
          : null;

      if (teardown) {
        // Recorded separately from the removal because it is a separate act
        // with a separate outcome: the connection is gone the moment this
        // returns, while the container stops whenever the applier next runs.
        req.services.audit.record({
          action: 'connection.bridge.teardown_requested',
          actor: actorOf(req),
          outcome: 'success',
          targetType: 'connection',
          targetId: record.id,
          requestId: req.id,
          ip: req.ip,
          metadata: {
            template: teardown.template,
            instance: teardown.instance,
            requestId: teardown.requestId,
          },
        });
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
        metadata: {
          provider: record.provider,
          name: record.name,
          bridgeTeardownRequested: teardown !== null,
        },
      });

      return ok(
        { removed: true, id: record.id, bridgeTeardownRequested: teardown !== null },
        req.id,
      );
    },
  );

  // --- POST /connections/:connectionId/probe --------------------------------
  app.post<{ Params: { connectionId: string } }>(
    '/connections/:connectionId/probe',
    {
      preHandler: requirePermission('connections.view'),
      // On-demand outbound request to a third-party address.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
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
    {
      preHandler: requirePermission('connections.manage'),
      // A sign-in attempt sends credentials to a third party and can make it
      // mail or text a code to a real person. Tight, so neither this gateway
      // nor an upstream can be used to hammer an account or spam an inbox.
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    },
    async (req) => {
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);
      const result = await store.beginAuth(record.id, req.principal?.userId ?? null);

      req.services.audit.record({
        action: 'connection.auth.started',
        actor: actorOf(req),
        outcome: result.status === 'failed' ? 'failure' : 'success',
        targetType: 'connection',
        targetId: record.id,
        requestId: req.id,
        ip: req.ip,
        metadata: {
          provider: record.provider,
          result: result.status,
          // The user-facing reason on failure, so a bad sign-in is diagnosable
          // from the audit trail. It is the same text shown in the app, never a
          // credential.
          ...(result.status === 'failed' ? { reason: result.message } : {}),
        },
      });

      return ok(result, req.id);
    },
  );

  // --- POST /connections/:connectionId/auth/complete ------------------------
  app.post<{ Params: { connectionId: string } }>(
    '/connections/:connectionId/auth/complete',
    {
      preHandler: requirePermission('connections.manage'),
      // Submitting a code is a guess against a short numeric secret; limiting
      // it is what stops the code space being walked.
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (req) => {
      const body = CompleteAuthBody.parse(req.body ?? {});
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);
      const result = await store.completeAuth(
        record.id,
        body.challengeId,
        body.code,
        req.principal?.userId ?? null,
      );

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
        metadata: {
          provider: record.provider,
          result: result.status,
          // The user-facing reason on failure, so a bad sign-in is diagnosable
          // from the audit trail. It is the same text shown in the app, never a
          // credential.
          ...(result.status === 'failed' ? { reason: result.message } : {}),
        },
      });

      if (result.status === 'complete') {
        // A successful sign-in usually makes the source reachable; refresh the
        // health so the screen the user returns to is already correct.
        await store.probe(record.id);
      }
      return ok(result, req.id);
    },
  );

  // --- POST /connections/:connectionId/provision ----------------------------
  // Asks the host to stand up the helper service this provider needs.
  //
  // The gateway holds no Docker access and this route grants none: it writes a
  // file naming one of the applier's vetted templates, and the applier decides
  // whether it recognises it. The entire privilege being exercised here is
  // "start one of N known things for a connection that already exists", which is
  // why an administrator may do it and an operator may not.
  app.post<{ Params: { connectionId: string } }>(
    '/connections/:connectionId/provision',
    {
      preHandler: requirePermission('connections.manage'),
      // Creating containers is the most expensive thing this API can cause. The
      // store enforces a hard ceiling; this stops anyone reaching it quickly.
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    },
    async (req) => {
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);

      const endpoint = 'POST /connections/:connectionId/provision';
      const { value } = await withIdempotency(req, endpoint, { id: record.id }, async () => {
        const provisioning = await store.requestProvisioning(
          record.id,
          req.principal?.userId ?? null,
        );

        req.services.audit.record({
          action: 'connection.bridge.requested',
          actor: actorOf(req),
          outcome: 'success',
          targetType: 'connection',
          targetId: record.id,
          requestId: req.id,
          ip: req.ip,
          // Which template, and under what instance name — the two facts needed
          // to find the container this request produced. The hand-over values
          // are credentials and never enter the log.
          metadata: {
            provider: record.provider,
            template: provisioning.template,
            instance: provisioning.instance,
            requestId: provisioning.requestId,
          },
        });

        return { provisioning };
      });

      return ok(value, req.id);
    },
  );

  // --- GET /connections/:connectionId/provisioning --------------------------
  // The state of that request, after reading whatever the applier has since
  // written back. This is the one the app polls while a bridge is being built,
  // so it reconciles where the list route deliberately does not.
  app.get<{ Params: { connectionId: string } }>(
    '/connections/:connectionId/provisioning',
    {
      preHandler: requirePermission('connections.view'),
      // Polled every few seconds by an open screen, so it is bounded — but far
      // more loosely than anything that causes work.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req) => {
      const store = storeOf(req.services);
      const record = store.get(req.params.connectionId);
      const provisioning = await store.provisioningState(record.id);
      return ok({ provisioning, available: store.provisioningAvailable }, req.id);
    },
  );
}
