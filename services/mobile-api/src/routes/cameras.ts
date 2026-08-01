/**
 * Camera routes: listing, snapshots, stream authorisation and controls.
 *
 * Stream URLs are never handed out as durable links. The app receives a
 * gateway-signed, short-lived, user-bound stream token; the playback URL is
 * resolved server-side and can be revoked at any time.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../lib/errors.ts';
import { ok } from '../lib/envelope.ts';
import { randomId } from '../lib/crypto.ts';
import { actorOf, requireAuth, requirePermission, withIdempotency } from '../http/context.ts';
import type {
  Camera,
  CameraControlRequest,
  StreamProtocol,
  StreamQuality,
} from '../adapters/orionis/types.ts';
import type { Permission } from '../auth/roles.ts';
import { can } from '../auth/roles.ts';

const StreamRequest = z.object({
  preferredProtocols: z
    .array(z.enum(['webrtc', 'llhls', 'hls', 'mjpeg']))
    .min(1)
    .default(['webrtc', 'llhls', 'hls']),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  lowData: z.boolean().default(false),
});

const ControlRequest = z.object({
  action: z.enum([
    'ptz',
    'preset',
    'zoom',
    'light',
    'siren',
    'privacy',
    'recording',
    'motion',
    'sensitivity',
    'restart',
  ]),
  direction: z.enum(['up', 'down', 'left', 'right', 'stop']).optional(),
  presetId: z.string().max(64).optional(),
  value: z.union([z.boolean(), z.number()]).optional(),
  speed: z.number().min(0).max(1).optional(),
});

/** Each control action maps to the permission that gates it. */
const CONTROL_PERMISSION: Record<CameraControlRequest['action'], Permission> = {
  ptz: 'cameras.control.ptz',
  preset: 'cameras.control.ptz',
  zoom: 'cameras.control.ptz',
  light: 'cameras.control.light',
  siren: 'cameras.control.siren',
  privacy: 'cameras.control.privacy',
  recording: 'cameras.control.recording',
  motion: 'cameras.control.detection',
  sensitivity: 'cameras.control.detection',
  restart: 'cameras.restart',
};

/** And to the capability flag the camera must advertise. */
function capabilitySupported(camera: Camera, action: CameraControlRequest['action']): boolean {
  const c = camera.capabilities;
  switch (action) {
    case 'ptz':
      return c.ptz;
    case 'preset':
      return c.presets;
    case 'zoom':
      return c.zoom;
    case 'light':
      return c.light;
    case 'siren':
      return c.siren;
    case 'privacy':
      return c.privacyMode;
    case 'recording':
      return c.recordingToggle;
    case 'motion':
      return c.motionToggle;
    case 'sensitivity':
      return c.sensitivity;
    case 'restart':
      return c.restart;
  }
}

/** Disruptive actions require an explicit confirmation flag from the client. */
const DISRUPTIVE: ReadonlySet<CameraControlRequest['action']> = new Set([
  'siren',
  'privacy',
  'restart',
  'recording',
]);

export async function registerCameraRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /cameras ---------------------------------------------------------
  app.get('/cameras', { preHandler: requirePermission('cameras.view') }, async (req) => {
    const cameras = await req.services.orionis.listCameras();
    return ok({ items: cameras, total: cameras.length }, req.id);
  });

  // --- GET /cameras/:cameraId ----------------------------------------------
  app.get<{ Params: { cameraId: string } }>(
    '/cameras/:cameraId',
    { preHandler: requirePermission('cameras.view') },
    async (req) => ok(await req.services.orionis.getCamera(req.params.cameraId), req.id),
  );

  // --- GET /cameras/:cameraId/snapshot -------------------------------------
  app.get<{ Params: { cameraId: string } }>(
    '/cameras/:cameraId/snapshot',
    { preHandler: requirePermission('cameras.snapshot') },
    async (req, reply) => {
      const snap = await req.services.orionis.getSnapshot(req.params.cameraId);
      return reply
        .header('content-type', snap.contentType)
        .header('cache-control', 'private, max-age=5')
        .header('x-captured-at', snap.capturedAt)
        .send(snap.bytes);
    },
  );

  // --- POST /cameras/:cameraId/stream-sessions ------------------------------
  app.post<{ Params: { cameraId: string } }>(
    '/cameras/:cameraId/stream-sessions',
    {
      preHandler: requirePermission('cameras.stream'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = StreamRequest.parse(req.body ?? {});
      const { orionis, config, db, audit } = req.services;
      const principal = req.principal!;
      const cameraId = req.params.cameraId;

      const camera = await orionis.getCamera(cameraId);
      if (camera.health.status === 'offline') {
        throw new AppError(
          'CAMERA_OFFLINE',
          `${camera.name} is offline and cannot start a stream.`,
        );
      }

      // Negotiate: intersect what the client prefers with what the camera has,
      // preserving the client's ordering (webrtc → llhls → hls → mjpeg).
      const supported = camera.capabilities.protocols;
      const negotiated = body.preferredProtocols.find((p) => supported.includes(p));
      if (!negotiated) {
        throw new AppError(
          'STREAM_UNAVAILABLE',
          `${camera.name} does not support any of the requested stream protocols.`,
          { cameraSupports: supported },
        );
      }

      const quality: StreamQuality = body.lowData ? 'low' : body.quality;

      const upstream = await orionis.createStreamSession({
        cameraId,
        preferredProtocols: [negotiated as StreamProtocol],
        quality,
        ttlSeconds: config.streamTokenTtlSeconds,
      });

      const localId = randomId('str');
      const expiresAt = new Date(Date.now() + config.streamTokenTtlSeconds * 1000);

      db.prepare(
        `INSERT INTO stream_sessions (id, user_id, session_id, camera_id, protocol, quality, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        localId,
        principal.userId,
        principal.sessionId,
        cameraId,
        upstream.protocol,
        quality,
        new Date().toISOString(),
        expiresAt.toISOString(),
      );

      // The token binds playback to this user, session, camera and window.
      const streamToken = await new SignJWT({
        sid: principal.sessionId,
        cam: cameraId,
        str: localId,
        proto: upstream.protocol,
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('orionis-control-gateway')
        .setAudience('orionis-control-stream')
        .setSubject(principal.userId)
        .setIssuedAt()
        .setExpirationTime(`${config.streamTokenTtlSeconds}s`)
        .sign(new TextEncoder().encode(config.sessionSigningKey));

      audit.record({
        action: 'camera.stream.session_created',
        actor: actorOf(req),
        outcome: 'success',
        targetType: 'camera',
        targetId: cameraId,
        requestId: req.id,
        ip: req.ip,
        metadata: { protocol: upstream.protocol, quality },
      });

      return ok(
        {
          id: localId,
          cameraId,
          protocol: upstream.protocol,
          quality,
          supportedQualities: upstream.supportedQualities,
          // Resolved through the gateway, not a durable upstream URL.
          playbackUrl: `${config.publicBaseUrl}/api/mobile/v1/stream/${localId}`,
          streamToken,
          expiresAt: expiresAt.toISOString(),
          iceServers: upstream.iceServers,
          renewAfterSeconds: Math.max(15, config.streamTokenTtlSeconds - 30),
        },
        req.id,
      );
    },
  );

  // --- DELETE /cameras/:cameraId/stream-sessions/:streamId ------------------
  app.delete<{ Params: { cameraId: string; streamId: string } }>(
    '/cameras/:cameraId/stream-sessions/:streamId',
    { preHandler: requireAuth },
    async (req) => {
      const { db, orionis } = req.services;
      const principal = req.principal!;
      const row = db
        .prepare('SELECT * FROM stream_sessions WHERE id = ? AND user_id = ?')
        .get(req.params.streamId, principal.userId) as Record<string, unknown> | undefined;
      if (!row) throw AppError.notFound('That stream session');

      db.prepare('UPDATE stream_sessions SET revoked_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        req.params.streamId,
      );
      // Best effort upstream teardown; local revocation already stops playback.
      await orionis.revokeStreamSession(req.params.streamId).catch(() => undefined);
      return ok({ revoked: true }, req.id);
    },
  );

  // --- GET /stream/:streamId (playback resolution) --------------------------
  // Registered outside the authenticated prefix guard: players cannot always
  // attach an Authorization header, so the short-lived stream token is passed
  // as a bearer header when possible and validated here either way.
  app.get<{ Params: { streamId: string }; Querystring: { token?: string } }>(
    '/stream/:streamId',
    async (req, reply) => {
      const { config, db } = req.services;
      const header = req.headers.authorization;
      const token =
        (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
          ? header.slice(7).trim()
          : null) ?? req.query.token;

      if (!token) {
        throw new AppError('UNAUTHENTICATED', 'A stream token is required.');
      }

      let claims;
      try {
        ({ payload: claims } = await jwtVerify(
          token,
          new TextEncoder().encode(config.sessionSigningKey),
          { issuer: 'orionis-control-gateway', audience: 'orionis-control-stream' },
        ));
      } catch {
        throw new AppError('STREAM_TOKEN_EXPIRED', 'This stream token is invalid or has expired.');
      }

      const row = db
        .prepare('SELECT * FROM stream_sessions WHERE id = ?')
        .get(String(claims.str)) as Record<string, unknown> | undefined;

      if (!row || row.revoked_at) {
        throw new AppError('STREAM_UNAVAILABLE', 'This stream session was revoked.');
      }
      if (new Date(String(row.expires_at)).getTime() < Date.now()) {
        throw new AppError('STREAM_TOKEN_EXPIRED', 'This stream session has expired.');
      }
      if (!req.services.sessions.isActive(String(row.session_id))) {
        throw new AppError('SESSION_REVOKED', 'The signed-in session is no longer valid.');
      }

      // The upstream media URL is resolved here and never returned to the app.
      // Implementations proxy or 302 to the upstream edge depending on protocol.
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        'Media relay is handled by the Orionis streaming edge, which is not connected to this gateway.',
      );

      return reply;
    },
  );

  // --- POST /cameras/:cameraId/controls -------------------------------------
  app.post<{ Params: { cameraId: string } }>(
    '/cameras/:cameraId/controls',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = ControlRequest.parse(req.body);
      const { orionis, audit } = req.services;
      const principal = req.principal!;
      const cameraId = req.params.cameraId;

      const permission = CONTROL_PERMISSION[body.action];
      if (!can(principal.role, permission)) {
        audit.record({
          action: 'camera.control.invoked',
          actor: actorOf(req),
          outcome: 'denied',
          targetType: 'camera',
          targetId: cameraId,
          reason: `missing ${permission}`,
          requestId: req.id,
          ip: req.ip,
          metadata: { control: body.action },
        });
        throw new AppError(
          'INSUFFICIENT_ROLE',
          `Your role (${principal.role}) is not permitted to use this control.`,
          { requiredPermission: permission },
        );
      }

      const camera = await orionis.getCamera(cameraId);
      if (!capabilitySupported(camera, body.action)) {
        throw AppError.unsupported(`The "${body.action}" control on ${camera.name}`);
      }

      const confirmed = req.headers['x-confirm-disruptive'] === 'true';
      if (DISRUPTIVE.has(body.action) && !confirmed) {
        throw new AppError(
          'VALIDATION_FAILED',
          'This control is disruptive and requires explicit confirmation.',
          { requiresHeader: 'X-Confirm-Disruptive: true' },
        );
      }

      const endpoint = `POST /cameras/${cameraId}/controls`;
      const { value, replayed } = await withIdempotency(req, endpoint, body, async () => {
        const result = await orionis.invokeControl(cameraId, body as CameraControlRequest);
        audit.record({
          action: body.action === 'restart' ? 'camera.restart' : 'camera.control.invoked',
          actor: actorOf(req),
          outcome: result.applied ? 'success' : 'failure',
          targetType: 'camera',
          targetId: cameraId,
          requestId: req.id,
          ip: req.ip,
          metadata: { control: body.action, direction: body.direction, value: body.value },
        });
        return result;
      });

      return ok({ ...value, replayed }, req.id);
    },
  );
}
