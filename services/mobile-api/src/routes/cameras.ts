/**
 * Camera routes: listing, snapshots, stream authorisation and controls.
 *
 * Stream URLs are never handed out as durable links. The app receives a
 * gateway-signed, short-lived, user-bound stream token; the playback URL is
 * resolved server-side and can be revoked at any time.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
  /**
   * go2rtc mints a short-lived HLS session id for every `stream.m3u8` request
   * and drops it a few seconds after the last poll — or immediately if the
   * upstream source hiccups. That id must therefore never reach the client: a
   * player that holds one is permanently dead the moment go2rtc forgets it,
   * which shows up as a stream that plays and then goes black forever.
   *
   * The gateway owns the session instead. Client playlist URLs carry no id;
   * this map resolves the current one per stream session and re-mints it on
   * demand, so a source hiccup costs one playlist reload rather than the
   * whole playback.
   */
  const hlsSessions = new Map<string, string>();

  /**
   * Resolves the upstream's current variant-playlist URL for a camera and
   * caches it against the gateway's own stream id.
   *
   * MediaMTX (`hlsBaseUrl` set) names the variant in `index.m3u8` as
   * `main_stream.m3u8?session=<uuid>`; go2rtc names it as
   * `hls/playlist.m3u8?id=<sid>`. Both are ephemeral, hence the same
   * ownership rule for both.
   */
  const mintHlsSession = async (
    streamId: string,
    src: string,
    config: { orionis: { baseUrl: string; hlsBaseUrl: string; timeoutMs: number } },
  ): Promise<string> => {
    const { baseUrl, hlsBaseUrl, timeoutMs } = config.orionis;
    const masterUrl = hlsBaseUrl
      ? `${hlsBaseUrl}/${encodeURIComponent(src)}/index.m3u8`
      : `${baseUrl}/api/stream.m3u8?src=${encodeURIComponent(src)}`;

    const upstream = await fetch(masterUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!upstream.ok) {
      throw new AppError('STREAM_UNAVAILABLE', 'The camera stream is not available.');
    }
    const body = await upstream.text();
    const variant = hlsBaseUrl
      ? /^([A-Za-z0-9._-]+\.m3u8\?session=[A-Za-z0-9-]+)$/m.exec(body)?.[1]
      : /hls\/playlist\.m3u8\?id=([A-Za-z0-9_-]+)/.exec(body)?.[1];
    if (!variant) {
      throw new AppError('STREAM_UNAVAILABLE', 'The camera stream is not available.');
    }
    hlsSessions.set(streamId, variant);
    return variant;
  };

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
          // `.m3u8` is load-bearing: AVFoundation will not follow an
          // extension-less playlist URL, however correct the content type.
          playbackUrl: `${config.publicBaseUrl}/api/mobile/v1/stream/${localId}/playlist.m3u8`,
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
      hlsSessions.delete(req.params.streamId);
      return ok({ revoked: true }, req.id);
    },
  );

  // --- GET /stream/:streamId/... (playback resolution) ----------------------
  // Registered outside the authenticated prefix guard: players cannot always
  // attach an Authorization header, so the short-lived stream token is passed
  // as a bearer header when possible and validated here either way.
  //
  // The paths end in `.m3u8` and `.ts` deliberately. AVFoundation would not
  // follow an extension-less playlist URL even with the right content type —
  // it re-requested the top-level URL in a loop and never fetched the variant,
  // which looked like a camera that connects and then shows nothing.
  const relayHandler = async (
    req: FastifyRequest<{
      Params: { streamId: string };
      Querystring: { token?: string; id?: string; n?: string; f?: string; s?: string };
    }>,
    reply: FastifyReply,
  ): Promise<unknown> => {
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

    const row = db.prepare('SELECT * FROM stream_sessions WHERE id = ?').get(String(claims.str)) as
      Record<string, unknown> | undefined;

    if (!row || row.revoked_at) {
      throw new AppError('STREAM_UNAVAILABLE', 'This stream session was revoked.');
    }
    if (new Date(String(row.expires_at)).getTime() < Date.now()) {
      throw new AppError('STREAM_TOKEN_EXPIRED', 'This stream session has expired.');
    }
    if (!req.services.sessions.isActive(String(row.session_id))) {
      throw new AppError('SESSION_REVOKED', 'The signed-in session is no longer valid.');
    }

    // HLS relay for the go2rtc data plane. go2rtc is never exposed to the
    // client: the gateway serves the media playlist and the segments,
    // rewriting every segment URL back through this same token-bound endpoint.
    // There is no master playlist — go2rtc offers a single variant, so a master
    // adds an indirection (and a failure mode) for nothing.
    // go2rtc's HLS shape is:
    //   mint    /api/stream.m3u8?src=<name>  -> hls/playlist.m3u8?id=<sid>
    //   media   /api/hls/playlist.m3u8?id=<sid> -> segment.ts?id=<sid>&n=<n>
    //   segment /api/hls/segment.ts?id=<sid>&n=<n>
    const { baseUrl: go2rtcBase, hlsBaseUrl, timeoutMs } = config.orionis;
    const src = String(row.camera_id);
    const streamId = req.params.streamId;
    const self = `${config.publicBaseUrl}/api/mobile/v1/stream/${streamId}`;
    const tq = `token=${encodeURIComponent(token)}`;
    const noStore = { 'cache-control': 'no-store' };
    const isSegment = req.url.split('?')[0]!.endsWith('.ts');

    try {
      if (!isSegment) {
        const fetchPlaylist = async (variant: string): Promise<Response> =>
          fetch(
            hlsBaseUrl
              ? `${hlsBaseUrl}/${encodeURIComponent(src)}/${variant}`
              : `${go2rtcBase}/api/hls/playlist.m3u8?id=${encodeURIComponent(variant)}`,
            { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' },
          );

        let variant = hlsSessions.get(streamId) ?? (await mintHlsSession(streamId, src, config));
        let upstream = await fetchPlaylist(variant);

        // The session expired or the source dropped: mint a fresh one rather
        // than failing the request. The player keeps polling this same URL, so
        // recovery is invisible to it.
        if (!upstream.ok) {
          variant = await mintHlsSession(streamId, src, config);
          upstream = await fetchPlaylist(variant);
        }
        if (!upstream.ok) {
          throw new AppError('STREAM_UNAVAILABLE', 'The camera stream is not available.');
        }

        // Segment URLs stay pinned to the session that produced this playlist:
        // segment numbering is per-session, so a number from an older one must
        // not silently resolve against a newer session.
        const text = await upstream.text();
        const body = hlsBaseUrl
          ? text.replace(
              /^([A-Za-z0-9._-]+\.ts)\?session=([A-Za-z0-9-]+)$/gm,
              (_m, file, session) => `${self}/segment.ts?${tq}&f=${file}&s=${session}`,
            )
          : text.replace(
              /segment\.ts\?id=([A-Za-z0-9_-]+)&n=(\d+)/g,
              (_m, id, n) => `${self}/segment.ts?${tq}&id=${id}&n=${n}`,
            );
        return reply
          .headers({ 'content-type': 'application/vnd.apple.mpegurl', ...noStore })
          .send(body);
      }

      let segmentUrl: string;
      if (hlsBaseUrl) {
        // Anchored allowlist, not a sanitiser: the filename lands in a URL path
        // segment, so anything outside this shape (traversal, absolute paths,
        // query injection) is rejected rather than escaped.
        const file = req.query.f ?? '';
        if (!/^[A-Za-z0-9._-]+\.ts$/.test(file)) {
          throw new AppError('STREAM_UNAVAILABLE', 'The camera stream segment is not available.');
        }
        segmentUrl = `${hlsBaseUrl}/${encodeURIComponent(src)}/${file}?session=${encodeURIComponent(req.query.s ?? '')}`;
      } else {
        segmentUrl = `${go2rtcBase}/api/hls/segment.ts?id=${encodeURIComponent(req.query.id ?? '')}&n=${encodeURIComponent(req.query.n ?? '')}`;
      }

      const upstream = await fetch(segmentUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!upstream.ok) {
        // 404, not 503: a segment from a retired session is gone for good, and
        // HLS players respond to a missing segment by reloading the playlist —
        // which is exactly the resync we want. A 5xx makes them give up.
        return reply.code(404).headers(noStore).send();
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      return reply.headers({ 'content-type': 'video/mp2t', ...noStore }).send(buf);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('UPSTREAM_UNAVAILABLE', 'The streaming data plane did not respond.');
    }
  };

  app.get('/stream/:streamId/playlist.m3u8', relayHandler);
  app.get('/stream/:streamId/segment.ts', relayHandler);
  // Kept so a client holding an older playback URL still resolves to the
  // playlist rather than a 404.
  app.get('/stream/:streamId', relayHandler);

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
