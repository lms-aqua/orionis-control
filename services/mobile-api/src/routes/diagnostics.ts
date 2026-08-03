/** Bounded client incident intake. Payloads are deliberately structured: no
 * SDP, URLs, credentials, raw errors, or arbitrary log messages are accepted. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, requirePermission } from '../http/context.ts';
import { ok } from '../lib/envelope.ts';

const IncidentBody = z
  .object({
    kind: z.enum([
      'webrtc_negotiation_failed',
      'webrtc_connection_dropped',
      'webrtc_no_first_frame',
      'webrtc_frames_stalled',
      'webrtc_low_frame_rate',
      'hls_playback_stalled',
      'hls_playback_failed',
      'stream_recovery_exhausted',
    ]),
    action: z.enum(['observed', 'renegotiating', 'downshifting', 'falling_back']),
    cameraId: z.string().min(1).max(128),
    transport: z.enum(['webrtc', 'hls', 'llhls', 'mjpeg']),
    occurredAt: z.string().datetime(),
    metrics: z
      .object({
        framesPerSecond: z.number().finite().min(0).max(240).optional(),
        baselineFramesPerSecond: z.number().finite().min(0).max(240).optional(),
        staleSeconds: z.number().finite().min(0).max(3600).optional(),
        resolution: z
          .string()
          .regex(/^\d{1,5}x\d{1,5}$/)
          .optional(),
        connectionAttempts: z.number().int().min(0).max(10_000),
        reconnectCount: z.number().int().min(0).max(10_000),
        stallCount: z.number().int().min(0).max(10_000),
      })
      .strict(),
    context: z
      .object({
        lowData: z.boolean(),
        lowPowerMode: z.boolean(),
        thermalState: z.enum(['nominal', 'fair', 'serious', 'critical', 'unknown']),
        // Optional for compatibility with clients released before quality
        // adaptation. New clients always include it.
        requestedQuality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
        activeQuality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
      })
      .strict(),
  })
  .strict();

export async function registerDiagnosticRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/diagnostics/incidents',
    {
      preHandler: requirePermission('cameras.stream'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const incident = IncidentBody.parse(req.body);
      const reason = `Client reported ${incident.kind.replaceAll('_', ' ')}; ${incident.action.replaceAll('_', ' ')}`;

      req.log.warn(
        {
          mediaIncident: {
            ...incident,
            actorId: req.principal!.userId,
            deviceId: req.principal!.deviceId,
          },
        },
        'client media incident',
      );

      const record = req.services.audit.record({
        action: 'client.media.incident_reported',
        actor: actorOf(req),
        outcome: 'failure',
        targetType: 'camera',
        targetId: incident.cameraId,
        reason,
        requestId: req.id,
        ip: req.ip,
        metadata: incident,
      });

      return ok({ accepted: true, incidentId: record.id }, req.id);
    },
  );
}
