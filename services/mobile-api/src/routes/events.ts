/**
 * Events and recordings.
 *
 * Acknowledgement state is owned by the gateway (so it works even when the
 * upstream has no such concept) and is mirrored upstream on a best-effort
 * basis. The local record is authoritative for the app.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.ts';
import { ok, paged } from '../lib/envelope.ts';
import { actorOf, requirePermission } from '../http/context.ts';
import type { CameraEvent } from '../adapters/orionis/types.ts';
import type { Db } from '../db/index.ts';

const EventQuerySchema = z.object({
  cameraIds: z.string().optional(),
  types: z.string().optional(),
  severities: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  acknowledged: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const RecordingQuerySchema = z.object({
  cameraIds: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const AcknowledgeBody = z.object({
  note: z.string().max(500).nullable().optional(),
});

const split = (v: string | undefined): string[] | undefined =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

interface AckRow {
  event_id: string;
  acknowledged_by: string;
  actor_name: string;
  acknowledged_at: string;
  note: string | null;
}

/** Merges locally-held acknowledgement state onto upstream events. */
export function mergeAcknowledgements(events: CameraEvent[], db: Db): CameraEvent[] {
  if (events.length === 0) return events;
  const placeholders = events.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM event_acknowledgements WHERE event_id IN (${placeholders})`)
    .all(...events.map((e) => e.id)) as unknown as AckRow[];
  const byId = new Map(rows.map((r) => [r.event_id, r]));

  return events.map((e) => {
    const ack = byId.get(e.id);
    if (!ack) return e;
    return {
      ...e,
      acknowledged: true,
      acknowledgedBy: ack.actor_name,
      acknowledgedAt: ack.acknowledged_at,
      note: ack.note,
    };
  });
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /events ----------------------------------------------------------
  app.get('/events', { preHandler: requirePermission('events.view') }, async (req) => {
    const q = EventQuerySchema.parse(req.query);
    const { orionis, db } = req.services;

    const result = await orionis.listEvents({
      cameraIds: split(q.cameraIds),
      types: split(q.types) as never,
      severities: split(q.severities) as never,
      from: q.from,
      to: q.to,
      limit: q.limit,
      offset: q.offset,
    });

    let items = mergeAcknowledgements(result.items, db);

    // Acknowledgement is a gateway-side concept, so filter after the merge.
    if (q.acknowledged === 'true') items = items.filter((e) => e.acknowledged);
    if (q.acknowledged === 'false') items = items.filter((e) => !e.acknowledged);

    return paged(
      items,
      {
        total: result.total,
        limit: q.limit,
        offset: q.offset,
        hasMore:
          result.total !== null ? q.offset + items.length < result.total : items.length === q.limit,
      },
      req.id,
    );
  });

  // --- GET /events/:eventId -------------------------------------------------
  app.get<{ Params: { eventId: string } }>(
    '/events/:eventId',
    { preHandler: requirePermission('events.view') },
    async (req) => {
      const { orionis, db } = req.services;
      const event = await orionis.getEvent(req.params.eventId);
      const [merged] = mergeAcknowledgements([event], db);
      return ok(merged, req.id);
    },
  );

  // --- POST /events/:eventId/acknowledge ------------------------------------
  app.post<{ Params: { eventId: string } }>(
    '/events/:eventId/acknowledge',
    { preHandler: requirePermission('events.acknowledge') },
    async (req) => {
      const body = AcknowledgeBody.parse(req.body ?? {});
      const { orionis, db, audit } = req.services;
      const principal = req.principal!;
      const eventId = req.params.eventId;

      const existing = db
        .prepare('SELECT event_id FROM event_acknowledgements WHERE event_id = ?')
        .get(eventId);
      if (existing) {
        throw new AppError('CONFLICT', 'This event has already been acknowledged.');
      }

      // Confirm the event exists upstream before recording anything locally.
      const event = await orionis.getEvent(eventId);
      const now = new Date().toISOString();
      const note = body.note ?? null;

      const syncedUpstream = await orionis
        .acknowledgeEventUpstream(eventId, note)
        .catch(() => false);

      db.prepare(
        `INSERT INTO event_acknowledgements (event_id, camera_id, acknowledged_by, actor_name,
           acknowledged_at, note, synced_upstream) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        event.cameraId,
        principal.userId,
        principal.username,
        now,
        note,
        syncedUpstream ? 1 : 0,
      );

      audit.record({
        action: 'event.acknowledged',
        actor: actorOf(req),
        outcome: 'success',
        targetType: 'event',
        targetId: eventId,
        requestId: req.id,
        ip: req.ip,
        metadata: { cameraId: event.cameraId, syncedUpstream, hasNote: note !== null },
      });

      return ok(
        {
          ...event,
          acknowledged: true,
          acknowledgedBy: principal.username,
          acknowledgedAt: now,
          note,
          syncedUpstream,
        },
        req.id,
      );
    },
  );

  // --- GET /recordings ------------------------------------------------------
  app.get('/recordings', { preHandler: requirePermission('recordings.view') }, async (req) => {
    const q = RecordingQuerySchema.parse(req.query);
    const result = await req.services.orionis.listRecordings({
      cameraIds: split(q.cameraIds),
      from: q.from,
      to: q.to,
      limit: q.limit,
      offset: q.offset,
    });
    return paged(
      result.items,
      {
        total: result.total,
        limit: q.limit,
        offset: q.offset,
        hasMore:
          result.total !== null
            ? q.offset + result.items.length < result.total
            : result.items.length === q.limit,
      },
      req.id,
    );
  });

  // --- GET /recordings/:recordingId -----------------------------------------
  app.get<{ Params: { recordingId: string } }>(
    '/recordings/:recordingId',
    { preHandler: requirePermission('recordings.view') },
    async (req) => ok(await req.services.orionis.getRecording(req.params.recordingId), req.id),
  );
}
