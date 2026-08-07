/**
 * Frigate NVR.
 *
 * The fullest provider: cameras, object-detection events, recordings and
 * snapshots all map onto the Orionis model without invention. Frigate embeds
 * go2rtc for live view, so streaming reuses that rather than restreaming.
 *
 * Frigate's own camera identifier is its config key (`driveway`), which is
 * stable across restarts and renames of the friendly name — so that is what is
 * used as the upstream ID, and the friendly name is display-only.
 */
import { AppError } from '../../../lib/errors.ts';
import type {
  Camera,
  CameraControlRequest,
  CameraControlResult,
  CameraEvent,
  CameraEventType,
  EventQuery,
  Page,
  Recording,
  RecordingQuery,
  StorageStatus,
  StreamProtocol,
  StreamQuality,
  StreamSession,
} from '../../orionis/types.ts';
import { UNKNOWN_STORAGE } from '../../orionis/types.ts';
import type {
  CameraProvider,
  ProviderContext,
  ProviderDescriptor,
  ProbeResult,
} from '../provider.ts';

export const FRIGATE_DESCRIPTOR: ProviderDescriptor = {
  id: 'frigate',
  displayName: 'Frigate',
  summary:
    'Frigate NVR. Cameras, object-detection events, recordings and snapshots, with live view through its embedded go2rtc.',
  capabilities: {
    snapshots: true,
    liveStream: true,
    events: true,
    eventDetection: true,
    recordings: true,
    controls: false,
    storageReporting: true,
    interactiveAuth: false,
  },
  fields: [
    {
      key: 'baseUrl',
      label: 'Frigate URL',
      type: 'url',
      required: true,
      placeholder: 'http://frigate:5000',
      help: 'The Frigate web UI address, reachable from this gateway.',
    },
    {
      key: 'go2rtcUrl',
      label: 'go2rtc URL',
      type: 'url',
      required: false,
      placeholder: 'http://frigate:1984',
      help: "Frigate's embedded go2rtc. Leave blank to derive it from the Frigate URL on port 1984.",
    },
    {
      key: 'apiKey',
      label: 'API key',
      type: 'secret',
      required: false,
      help: 'Only if Frigate sits behind an authenticating proxy. Sent as Authorization: Bearer.',
    },
  ],
};

interface FrigateCameraConfig {
  enabled?: boolean;
  best_image_timeout?: number;
  detect?: { enabled?: boolean; width?: number; height?: number; fps?: number };
  record?: { enabled?: boolean };
  snapshots?: { enabled?: boolean };
  onvif?: { host?: string };
}

interface FrigateConfig {
  cameras?: Record<string, FrigateCameraConfig>;
}

interface FrigateCameraStats {
  camera_fps?: number;
  process_fps?: number;
  detection_fps?: number;
  skipped_fps?: number;
}

interface FrigateStats {
  cameras?: Record<string, FrigateCameraStats>;
  service?: { version?: string; storage?: Record<string, FrigateStorageEntry> };
}

interface FrigateStorageEntry {
  total?: number;
  used?: number;
  free?: number;
  mount_type?: string;
}

interface FrigateEvent {
  id: string;
  camera: string;
  label?: string;
  start_time?: number;
  end_time?: number | null;
  top_score?: number;
  score?: number;
  has_clip?: boolean;
  has_snapshot?: boolean;
  retain_indefinitely?: boolean;
}

interface FrigateRecordingSegment {
  start_time: number;
  end_time: number;
  duration?: number;
}

export class FrigateProvider implements CameraProvider {
  readonly descriptor = FRIGATE_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #baseUrl(): string {
    const raw = String(this.#ctx.settings.baseUrl ?? '').replace(/\/+$/, '');
    if (!raw) throw new AppError('SERVICE_NOT_CONFIGURED', 'No Frigate URL is set.');
    return raw;
  }

  /** Frigate publishes go2rtc on 1984 by default; derive rather than demand it. */
  get #go2rtcUrl(): string {
    const explicit = String(this.#ctx.settings.go2rtcUrl ?? '').replace(/\/+$/, '');
    if (explicit) return explicit;
    try {
      const url = new URL(this.#baseUrl);
      url.port = '1984';
      return url.toString().replace(/\/+$/, '');
    } catch {
      return this.#baseUrl;
    }
  }

  async #get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {};
    const apiKey = this.#ctx.secrets.apiKey;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await this.#ctx.fetchImpl(`${this.#baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AppError('UPSTREAM_ERROR', 'Frigate rejected the request (check the API key).');
      }
      if (response.status === 404) throw AppError.notFound('Frigate resource');
      throw new AppError('UPSTREAM_ERROR', `Frigate returned HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const config = await this.#get<FrigateConfig>('/api/config');
      const count = Object.keys(config.cameras ?? {}).length;
      return {
        ok: true,
        message: `Connected to Frigate; ${count} camera(s) configured.`,
        cameraCount: count,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Frigate could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    // Config and stats are fetched together: config says what exists, stats say
    // whether it is currently producing frames. Stats failing must not hide the
    // camera list, so it degrades to "unknown" rather than throwing.
    const config = await this.#get<FrigateConfig>('/api/config');
    const stats = await this.#get<FrigateStats>('/api/stats').catch(() => null);
    return Object.entries(config.cameras ?? {}).map(([key, cam]) =>
      this.#camera(key, cam, stats?.cameras?.[key] ?? null, stats?.service?.version ?? null),
    );
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const camera = (await this.listCameras()).find((c) => c.id === cameraId);
    if (!camera) throw AppError.notFound('Camera');
    return camera;
  }

  #camera(
    key: string,
    config: FrigateCameraConfig,
    stats: FrigateCameraStats | null,
    version: string | null,
  ): Camera {
    const enabled = config.enabled !== false;
    // Frigate reports camera_fps 0 for a source it cannot read. With no stats
    // at all the honest answer is "unknown", not "offline".
    const fps = stats?.camera_fps ?? null;
    const status: Camera['health']['status'] = !enabled
      ? 'offline'
      : stats === null
        ? 'unknown'
        : fps !== null && fps > 0
          ? 'online'
          : 'degraded';

    return {
      id: key,
      name: key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      location: null,
      group: null,
      model: null,
      firmware: version,
      capabilities: {
        // ONVIF presence is how Frigate advertises PTZ capability.
        ptz: Boolean(config.onvif?.host),
        presets: Boolean(config.onvif?.host),
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        audio: null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: config.snapshots?.enabled !== false,
        protocols: ['webrtc', 'mjpeg'],
        qualities: ['auto'],
      },
      health: {
        status,
        // Frigate's record.enabled is configuration, not observation — it says
        // recording is *meant* to be on. That is still the best available
        // signal, but a camera that is down is not recording regardless.
        recording: config.record?.enabled === true ? status === 'online' : false,
        streaming: status === 'online',
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: fps,
        resolution:
          config.detect?.width && config.detect?.height
            ? `${config.detect.width}x${config.detect.height}`
            : null,
        message: !enabled
          ? 'This camera is disabled in Frigate.'
          : status === 'degraded'
            ? 'Frigate is not receiving frames from this camera.'
            : null,
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    const headers: Record<string, string> = {};
    const apiKey = this.#ctx.secrets.apiKey;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await this.#ctx.fetchImpl(
      `${this.#baseUrl}/api/${encodeURIComponent(cameraId)}/latest.jpg`,
      { headers, signal: AbortSignal.timeout(this.#ctx.timeoutMs) },
    );
    if (!response.ok) {
      throw new AppError('CAMERA_OFFLINE', `Frigate could not return a frame (HTTP ${response.status}).`);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'image/jpeg',
      capturedAt: new Date().toISOString(),
    };
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    const protocol: StreamProtocol = input.preferredProtocols.includes('webrtc')
      ? 'webrtc'
      : 'mjpeg';
    const src = encodeURIComponent(input.cameraId);
    const playbackUrl =
      protocol === 'webrtc'
        ? `${this.#go2rtcUrl}/api/webrtc?src=${src}`
        : `${this.#baseUrl}/api/${src}?fps=10`;
    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol,
      playbackUrl,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // go2rtc tears the peer connection down when the client disconnects; there
    // is no server-side session handle to revoke.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    // Frigate does expose ONVIF PTZ, but only for cameras configured for it and
    // through a different shape than this contract. Claiming support and
    // failing per-camera would be worse than declaring it unsupported.
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Camera controls are not yet wired for Frigate connections.',
    );
  }

  async listEvents(query: EventQuery): Promise<Page<CameraEvent>> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 50));
    if (query.cameraIds?.length === 1) params.set('camera', query.cameraIds[0]!);
    if (query.from) params.set('after', String(Math.floor(Date.parse(query.from) / 1000)));
    if (query.to) params.set('before', String(Math.floor(Date.parse(query.to) / 1000)));

    const events = await this.#get<FrigateEvent[]>(`/api/events?${params.toString()}`);
    // Frigate filters by a single camera only; a multi-camera request is
    // narrowed here rather than silently returning everything.
    const wanted = new Set(query.cameraIds ?? []);
    const filtered =
      wanted.size > 1 ? events.filter((e) => wanted.has(e.camera)) : events;
    return { items: filtered.map((e) => this.#event(e)), total: null };
  }

  async getEvent(eventId: string): Promise<CameraEvent> {
    return this.#event(await this.#get<FrigateEvent>(`/api/events/${encodeURIComponent(eventId)}`));
  }

  #event(event: FrigateEvent): CameraEvent {
    const score = event.top_score ?? event.score ?? null;
    return {
      id: event.id,
      cameraId: event.camera,
      cameraName: null,
      type: mapLabel(event.label),
      // Frigate has no severity concept. Everything it detects is
      // informational; inventing warnings from labels would be editorialising.
      severity: 'info',
      occurredAt: new Date((event.start_time ?? 0) * 1000).toISOString(),
      endedAt: event.end_time ? new Date(event.end_time * 1000).toISOString() : null,
      confidence: score,
      thumbnailPath: event.has_snapshot ? `/api/events/${event.id}/snapshot.jpg` : null,
      clipPath: event.has_clip ? `/api/events/${event.id}/clip.mp4` : null,
      recordingId: null,
      retentionUntil: null,
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
      note: null,
    };
  }

  async listRecordings(query: RecordingQuery): Promise<Page<Recording>> {
    const cameras = query.cameraIds?.length
      ? query.cameraIds
      : (await this.listCameras()).map((c) => c.id);

    const pages = await Promise.all(
      cameras.map(async (camera) => {
        const segments = await this.#get<FrigateRecordingSegment[]>(
          `/api/${encodeURIComponent(camera)}/recordings`,
        ).catch(() => [] as FrigateRecordingSegment[]);
        return segments.map((s) => this.#recording(camera, s));
      }),
    );
    const items = pages.flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { items: items.slice(0, query.limit ?? 50), total: null };
  }

  async getRecording(recordingId: string): Promise<Recording> {
    // Recording IDs here are synthesised from camera + time window, since
    // Frigate addresses recordings by range rather than by identifier.
    const parts = recordingId.split('|');
    if (parts.length !== 3) throw AppError.notFound('Recording');
    const [camera, start, end] = parts;
    return this.#recording(camera!, {
      start_time: Number(start),
      end_time: Number(end),
    });
  }

  #recording(camera: string, segment: FrigateRecordingSegment): Recording {
    const start = segment.start_time;
    const end = segment.end_time;
    return {
      id: `${camera}|${start}|${end}`,
      cameraId: camera,
      cameraName: null,
      startedAt: new Date(start * 1000).toISOString(),
      endedAt: new Date(end * 1000).toISOString(),
      durationSeconds: Math.max(0, Math.round(segment.duration ?? end - start)),
      // Frigate's recordings index does not carry per-segment size or audio
      // presence; null rather than a guess.
      sizeBytes: null,
      hasAudio: null,
      retentionUntil: null,
      // Frigate addresses playback by camera and time range rather than by a
      // file path, so the clip endpoint is reconstructed from the window.
      playbackPath: `/api/${encodeURIComponent(camera)}/start/${start}/end/${end}/clip.mp4`,
      // Markers correlate detections onto the timeline. Frigate can supply them
      // via its events API, but joining every segment to its events would be a
      // request per segment; left empty until that is done in one query.
      markers: [],
    };
  }

  async getStorageStatus(): Promise<StorageStatus> {
    const stats = await this.#get<FrigateStats>('/api/stats').catch(() => null);
    const storage = stats?.service?.storage;
    if (!storage) return UNKNOWN_STORAGE;

    // Frigate reports several mounts; only the recordings volume is meaningful
    // here, and its figures are megabytes rather than bytes.
    const entry =
      Object.entries(storage).find(([path]) => path.includes('recordings'))?.[1] ??
      Object.values(storage)[0];
    if (!entry) return UNKNOWN_STORAGE;

    const mb = (v: number | undefined) => (typeof v === 'number' ? Math.round(v * 1024 * 1024) : null);
    return {
      ...UNKNOWN_STORAGE,
      totalBytes: mb(entry.total),
      usedBytes: mb(entry.used),
      freeBytes: mb(entry.free),
      recordingsBytes: mb(entry.used),
    };
  }
}

/** Frigate labels are open-ended; anything unrecognised stays generic motion. */
function mapLabel(label: string | undefined): CameraEventType {
  switch ((label ?? '').toLowerCase()) {
    case 'person':
      return 'person';
    case 'car':
    case 'truck':
    case 'motorcycle':
    case 'bus':
      return 'vehicle';
    case 'package':
      return 'package';
    case 'dog':
    case 'cat':
    case 'bird':
    case 'horse':
      return 'animal';
    default:
      return 'motion';
  }
}
