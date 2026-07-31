/**
 * HTTP adapter for Orionis Guard.
 *
 * IMPORTANT: the upstream contract this codes against is documented in
 * docs/ORIONIS_UPSTREAM_CONTRACT.md. Until the real Orionis Guard build exposes
 * those endpoints, this adapter is exercised by contract tests against a stub
 * server — it is NOT verified against production hardware. Responses are
 * validated with zod, so a mismatched upstream produces a clear UPSTREAM_ERROR
 * instead of malformed data reaching the app.
 */
import { z } from 'zod';
import { AppError } from '../../lib/errors.ts';
import { UpstreamClient } from '../../lib/http-upstream.ts';
import type {
  Camera,
  CameraControlRequest,
  CameraControlResult,
  CameraEvent,
  EventQuery,
  OrionisAdapter,
  OrionisServiceHealth,
  Page,
  Recording,
  RecordingQuery,
  StorageStatus,
  StreamProtocol,
  StreamQuality,
  StreamSession,
} from './types.ts';

const ProtocolSchema = z.enum(['webrtc', 'llhls', 'hls', 'mjpeg']);
const QualitySchema = z.enum(['auto', 'low', 'medium', 'high']);

const CapabilitiesSchema = z
  .object({
    ptz: z.boolean().default(false),
    presets: z.boolean().default(false),
    zoom: z.boolean().default(false),
    light: z.boolean().default(false),
    siren: z.boolean().default(false),
    privacy_mode: z.boolean().default(false),
    two_way_audio: z.boolean().default(false),
    audio: z.boolean().default(false),
    recording_toggle: z.boolean().default(false),
    motion_toggle: z.boolean().default(false),
    sensitivity: z.boolean().default(false),
    restart: z.boolean().default(false),
    snapshot: z.boolean().default(true),
    protocols: z.array(ProtocolSchema).default([]),
    qualities: z.array(QualitySchema).default(['auto']),
  })
  .passthrough();

const HealthSchema = z
  .object({
    status: z.enum(['online', 'offline', 'degraded', 'unknown']).default('unknown'),
    recording: z.boolean().default(false),
    streaming: z.boolean().default(false),
    motion_detected: z.boolean().default(false),
    privacy_enabled: z.boolean().default(false),
    last_seen_at: z.string().nullable().default(null),
    signal_quality: z.number().min(0).max(1).nullable().default(null),
    bitrate_kbps: z.number().nullable().default(null),
    frame_rate: z.number().nullable().default(null),
    resolution: z.string().nullable().default(null),
    message: z.string().nullable().default(null),
  })
  .passthrough();

const CameraSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    location: z.string().nullable().default(null),
    group: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    firmware: z.string().nullable().default(null),
    capabilities: CapabilitiesSchema,
    health: HealthSchema,
    snapshot_path: z.string().nullable().default(null),
  })
  .passthrough();

const EventSchema = z
  .object({
    id: z.string().min(1),
    camera_id: z.string().min(1),
    camera_name: z.string().nullable().default(null),
    type: z
      .enum([
        'motion',
        'person',
        'vehicle',
        'package',
        'animal',
        'audio',
        'offline',
        'online',
        'recording_failure',
        'tamper',
        'system',
      ])
      .default('motion'),
    severity: z.enum(['info', 'warning', 'critical']).default('info'),
    occurred_at: z.string(),
    ended_at: z.string().nullable().default(null),
    confidence: z.number().min(0).max(1).nullable().default(null),
    thumbnail_path: z.string().nullable().default(null),
    clip_path: z.string().nullable().default(null),
    recording_id: z.string().nullable().default(null),
    retention_until: z.string().nullable().default(null),
  })
  .passthrough();

const RecordingSchema = z
  .object({
    id: z.string().min(1),
    camera_id: z.string().min(1),
    camera_name: z.string().nullable().default(null),
    started_at: z.string(),
    ended_at: z.string(),
    duration_seconds: z.number().nonnegative(),
    size_bytes: z.number().nullable().default(null),
    has_audio: z.boolean().default(false),
    retention_until: z.string().nullable().default(null),
    playback_path: z.string().nullable().default(null),
    markers: z
      .array(z.object({ at: z.string(), type: z.string(), event_id: z.string() }))
      .default([]),
  })
  .passthrough();

const StreamSessionSchema = z
  .object({
    id: z.string().min(1),
    protocol: ProtocolSchema,
    playback_url: z.string().url(),
    expires_at: z.string(),
    quality: QualitySchema.default('auto'),
    ice_servers: z
      .array(
        z.object({
          urls: z.array(z.string()),
          username: z.string().optional(),
          credential: z.string().optional(),
        }),
      )
      .default([]),
    supported_qualities: z.array(QualitySchema).default(['auto']),
  })
  .passthrough();

const ListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number().nullable().default(null) });

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      'UPSTREAM_ERROR',
      `Orionis Guard returned a ${what} payload this gateway does not understand.`,
      { issues: result.error.issues.slice(0, 5).map((i) => i.path.join('.')) },
    );
  }
  return result.data;
}

export class HttpOrionisAdapter implements OrionisAdapter {
  readonly kind = 'http' as const;
  readonly configured = true;
  private readonly client: UpstreamClient;

  constructor(
    baseUrl: string,
    serviceToken: string,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new UpstreamClient(
      'Orionis Guard',
      baseUrl,
      serviceToken ? { authorization: `Bearer ${serviceToken}` } : {},
      timeoutMs,
      fetchImpl,
    );
  }

  private toCamera(raw: z.infer<typeof CameraSchema>): Camera {
    const c = raw.capabilities;
    const h = raw.health;
    return {
      id: raw.id,
      name: raw.name,
      location: raw.location,
      group: raw.group,
      model: raw.model,
      firmware: raw.firmware,
      snapshotPath: raw.snapshot_path,
      capabilities: {
        ptz: c.ptz,
        presets: c.presets,
        zoom: c.zoom,
        light: c.light,
        siren: c.siren,
        privacyMode: c.privacy_mode,
        twoWayAudio: c.two_way_audio,
        audio: c.audio,
        recordingToggle: c.recording_toggle,
        motionToggle: c.motion_toggle,
        sensitivity: c.sensitivity,
        restart: c.restart,
        snapshot: c.snapshot,
        protocols: c.protocols as StreamProtocol[],
        qualities: c.qualities as StreamQuality[],
      },
      health: {
        status: h.status,
        recording: h.recording,
        streaming: h.streaming,
        motionDetected: h.motion_detected,
        privacyEnabled: h.privacy_enabled,
        lastSeenAt: h.last_seen_at,
        signalQuality: h.signal_quality,
        bitrateKbps: h.bitrate_kbps,
        frameRate: h.frame_rate,
        resolution: h.resolution,
        message: h.message,
      },
    };
  }

  private toEvent(raw: z.infer<typeof EventSchema>): CameraEvent {
    return {
      id: raw.id,
      cameraId: raw.camera_id,
      cameraName: raw.camera_name,
      type: raw.type,
      severity: raw.severity,
      occurredAt: raw.occurred_at,
      endedAt: raw.ended_at,
      confidence: raw.confidence,
      thumbnailPath: raw.thumbnail_path,
      clipPath: raw.clip_path,
      recordingId: raw.recording_id,
      retentionUntil: raw.retention_until,
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
      note: null,
    };
  }

  private toRecording(raw: z.infer<typeof RecordingSchema>): Recording {
    return {
      id: raw.id,
      cameraId: raw.camera_id,
      cameraName: raw.camera_name,
      startedAt: raw.started_at,
      endedAt: raw.ended_at,
      durationSeconds: raw.duration_seconds,
      sizeBytes: raw.size_bytes,
      hasAudio: raw.has_audio,
      retentionUntil: raw.retention_until,
      playbackPath: raw.playback_path,
      markers: raw.markers.map((m) => ({
        at: m.at,
        type: m.type as CameraEvent['type'],
        eventId: m.event_id,
      })),
    };
  }

  async listCameras(): Promise<Camera[]> {
    const { data } = await this.client.request<unknown>({ path: '/api/v1/cameras' });
    const parsed = parseOrThrow(ListSchema(CameraSchema), data, 'camera list');
    return parsed.items.map((c) => this.toCamera(c));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const { data } = await this.client.request<unknown>({
      path: `/api/v1/cameras/${encodeURIComponent(cameraId)}`,
    });
    return this.toCamera(parseOrThrow(CameraSchema, data, 'camera'));
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    const { data } = await this.client.request<Buffer>({
      path: `/api/v1/cameras/${encodeURIComponent(cameraId)}/snapshot`,
      binary: true,
      headers: { accept: 'image/jpeg' },
    });
    if (!data || data.length === 0) {
      throw new AppError('CAMERA_OFFLINE', 'The camera did not return a snapshot.');
    }
    return { bytes: data, contentType: 'image/jpeg', capturedAt: new Date().toISOString() };
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    const { data } = await this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/cameras/${encodeURIComponent(input.cameraId)}/stream-sessions`,
      body: {
        preferred_protocols: input.preferredProtocols,
        quality: input.quality,
        ttl_seconds: input.ttlSeconds,
      },
    });
    const parsed = parseOrThrow(StreamSessionSchema, data, 'stream session');
    return {
      id: parsed.id,
      cameraId: input.cameraId,
      protocol: parsed.protocol,
      playbackUrl: parsed.playback_url,
      expiresAt: parsed.expires_at,
      quality: parsed.quality,
      iceServers: parsed.ice_servers,
      supportedQualities: parsed.supported_qualities,
    };
  }

  async revokeStreamSession(streamSessionId: string): Promise<void> {
    await this.client.request({
      method: 'DELETE',
      path: `/api/v1/stream-sessions/${encodeURIComponent(streamSessionId)}`,
    });
  }

  async invokeControl(cameraId: string, req: CameraControlRequest): Promise<CameraControlResult> {
    const { data } = await this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/cameras/${encodeURIComponent(cameraId)}/controls`,
      body: {
        action: req.action,
        direction: req.direction,
        preset_id: req.presetId,
        value: req.value,
        speed: req.speed,
      },
    });
    const parsed = parseOrThrow(
      z.object({
        applied: z.boolean(),
        state: z.record(z.unknown()).nullable().default(null),
        message: z.string().nullable().default(null),
      }),
      data,
      'control result',
    );
    return parsed;
  }

  async listEvents(query: EventQuery): Promise<Page<CameraEvent>> {
    const { data } = await this.client.request<unknown>({
      path: '/api/v1/events',
      query: {
        camera_ids: query.cameraIds?.join(','),
        types: query.types?.join(','),
        severities: query.severities?.join(','),
        from: query.from,
        to: query.to,
        limit: query.limit,
        offset: query.offset,
      },
    });
    const parsed = parseOrThrow(ListSchema(EventSchema), data, 'event list');
    return { items: parsed.items.map((e) => this.toEvent(e)), total: parsed.total };
  }

  async getEvent(eventId: string): Promise<CameraEvent> {
    const { data } = await this.client.request<unknown>({
      path: `/api/v1/events/${encodeURIComponent(eventId)}`,
    });
    return this.toEvent(parseOrThrow(EventSchema, data, 'event'));
  }

  async acknowledgeEventUpstream(eventId: string, note: string | null): Promise<boolean> {
    try {
      await this.client.request({
        method: 'POST',
        path: `/api/v1/events/${encodeURIComponent(eventId)}/acknowledge`,
        body: { note },
      });
      return true;
    } catch (err) {
      // Upstream acknowledgement is optional; local state is authoritative.
      if (err instanceof AppError && (err.code === 'NOT_FOUND' || err.code === 'UPSTREAM_ERROR')) {
        return false;
      }
      throw err;
    }
  }

  async listRecordings(query: RecordingQuery): Promise<Page<Recording>> {
    const { data } = await this.client.request<unknown>({
      path: '/api/v1/recordings',
      query: {
        camera_ids: query.cameraIds?.join(','),
        from: query.from,
        to: query.to,
        limit: query.limit,
        offset: query.offset,
      },
    });
    const parsed = parseOrThrow(ListSchema(RecordingSchema), data, 'recording list');
    return { items: parsed.items.map((r) => this.toRecording(r)), total: parsed.total };
  }

  async getRecording(recordingId: string): Promise<Recording> {
    const { data } = await this.client.request<unknown>({
      path: `/api/v1/recordings/${encodeURIComponent(recordingId)}`,
    });
    return this.toRecording(parseOrThrow(RecordingSchema, data, 'recording'));
  }

  async getStorageStatus(): Promise<StorageStatus> {
    const { data } = await this.client.request<unknown>({ path: '/api/v1/storage' });
    const parsed = parseOrThrow(
      z.object({
        total_bytes: z.number().nullable().default(null),
        used_bytes: z.number().nullable().default(null),
        free_bytes: z.number().nullable().default(null),
        retention_days: z.number().nullable().default(null),
        oldest_recording_at: z.string().nullable().default(null),
      }),
      data,
      'storage status',
    );
    return {
      totalBytes: parsed.total_bytes,
      usedBytes: parsed.used_bytes,
      freeBytes: parsed.free_bytes,
      retentionDays: parsed.retention_days,
      oldestRecordingAt: parsed.oldest_recording_at,
    };
  }

  async listServiceHealth(): Promise<OrionisServiceHealth[]> {
    const { data } = await this.client.request<unknown>({ path: '/api/v1/health/services' });
    const parsed = parseOrThrow(
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.enum(['healthy', 'warning', 'critical', 'offline', 'unknown']),
            version: z.string().nullable().default(null),
            uptime_seconds: z.number().nullable().default(null),
            message: z.string().nullable().default(null),
          }),
        ),
      }),
      data,
      'service health',
    );
    const checkedAt = new Date().toISOString();
    return parsed.items.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      version: s.version,
      uptimeSeconds: s.uptime_seconds,
      message: s.message,
      checkedAt,
    }));
  }

  async runServiceAction(
    serviceId: string,
    action: string,
  ): Promise<{ ok: boolean; message: string }> {
    const { data } = await this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/services/${encodeURIComponent(serviceId)}/actions`,
      body: { action },
    });
    const parsed = parseOrThrow(
      z.object({ ok: z.boolean(), message: z.string().default('') }),
      data,
      'service action result',
    );
    return parsed;
  }
}
