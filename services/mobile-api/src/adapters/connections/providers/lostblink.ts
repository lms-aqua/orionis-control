/**
 * Blink cameras via a lostblink instance.
 *
 * lostblink terminates Blink's proprietary IMMI/RTSPS transports and republishes
 * each camera to MediaMTX as ordinary RTSP, so this provider does no Blink
 * protocol work itself — it discovers what lostblink has published and hands
 * back stream URLs.
 *
 * Two Blink-specific truths shape this provider, and both are visible to the
 * operator rather than buried:
 *
 *   - **Live view drains batteries.** Blink caps a session at 300 seconds and
 *     continuous use flattens a battery camera in days. lostblink enforces its
 *     own budget; nothing here should encourage more sessions than that allows.
 *   - **lostblink is alpha.** Its protocol layer is unit-tested but, as of
 *     writing, unverified against live hardware. The descriptor says so, so the
 *     app can warn before anyone depends on it for security footage.
 */
import { AppError } from '../../../lib/errors.ts';
import type {
  Camera,
  CameraControlRequest,
  CameraControlResult,
  CameraEvent,
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

export const LOSTBLINK_DESCRIPTOR: ProviderDescriptor = {
  id: 'lostblink',
  displayName: 'Blink (lostblink)',
  summary:
    'Blink cameras through a lostblink bridge. Live view only. lostblink is alpha and unverified against live hardware — do not rely on it as a sole security source.',
  capabilities: {
    snapshots: false,
    liveStream: true,
    // lostblink surfaces Blink motion clips, but this provider does not yet
    // read them; declaring false is honest and can be raised later.
    events: false,
    eventDetection: false,
    recordings: false,
    controls: false,
    storageReporting: false,
  },
  fields: [
    {
      key: 'mediamtxApiUrl',
      label: 'MediaMTX API URL',
      type: 'url',
      required: true,
      placeholder: 'http://lostblink-mediamtx:9997',
      help: "The MediaMTX control API that lostblink publishes to. Used to discover which cameras are live.",
    },
    {
      key: 'rtspBaseUrl',
      label: 'RTSP base URL',
      type: 'url',
      required: true,
      placeholder: 'rtsp://lostblink-mediamtx:8554',
      help: 'Where the published streams are read from. Camera paths are appended to this.',
    },
  ],
};

/** MediaMTX v3 `/v3/paths/list` shape, narrowed to what is used. */
interface MediaMtxPath {
  name: string;
  ready?: boolean;
  readyTime?: string | null;
  tracks?: string[];
  bytesReceived?: number;
}

interface MediaMtxPathList {
  items?: MediaMtxPath[];
}

export class LostblinkProvider implements CameraProvider {
  readonly descriptor = LOSTBLINK_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #apiUrl(): string {
    const raw = String(this.#ctx.settings.mediamtxApiUrl ?? '').replace(/\/+$/, '');
    if (!raw) throw new AppError('SERVICE_NOT_CONFIGURED', 'No MediaMTX API URL is set.');
    return raw;
  }

  get #rtspBase(): string {
    return String(this.#ctx.settings.rtspBaseUrl ?? '').replace(/\/+$/, '');
  }

  async #paths(): Promise<MediaMtxPath[]> {
    const response = await this.#ctx.fetchImpl(`${this.#apiUrl}/v3/paths/list`, {
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError('UPSTREAM_ERROR', `MediaMTX returned HTTP ${response.status}.`);
    }
    const body = (await response.json()) as MediaMtxPathList;
    return body.items ?? [];
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const paths = await this.#paths();
      const ready = paths.filter((p) => p.ready).length;
      return {
        ok: true,
        message:
          paths.length === 0
            ? 'Reached MediaMTX, but lostblink has not published any cameras yet.'
            : `${ready} of ${paths.length} Blink camera(s) are publishing.`,
        cameraCount: paths.length,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'MediaMTX could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    return (await this.#paths()).map((path) => this.#camera(path));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const path = (await this.#paths()).find((p) => p.name === cameraId);
    if (!path) throw AppError.notFound('Camera');
    return this.#camera(path);
  }

  #camera(path: MediaMtxPath): Camera {
    const ready = path.ready === true;
    return {
      id: path.name,
      name: path.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      location: null,
      group: null,
      model: null,
      firmware: null,
      capabilities: {
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        // Blink cameras do carry audio, but whether this path has an audio
        // track is only knowable from the track list.
        audio: path.tracks ? path.tracks.some((t) => /audio|aac|opus/i.test(t)) : null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: false,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        status: ready ? 'online' : 'offline',
        recording: null,
        streaming: ready,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: path.readyTime ?? null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: ready
          ? null
          : // Idle is the normal resting state for a battery camera, not a
            // fault, and saying "offline" without this reads as broken.
            'No live session. Blink cameras publish only while a live view is open.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'lostblink does not expose stills. A snapshot would require opening a live session, which drains the camera battery.',
    );
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    if (!this.#rtspBase) {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'No RTSP base URL is set.');
    }
    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      playbackUrl: `${this.#rtspBase}/${input.cameraId}`,
      // Blink caps a live session at 300 seconds and lostblink splices a
      // replacement before then. Never promise longer than the cap.
      expiresAt: new Date(Date.now() + Math.min(input.ttlSeconds, 300) * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // lostblink owns session lifecycle and its own budget; tearing a session
    // down from here would fight its splice logic.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Blink cameras expose no controls through lostblink.');
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Blink motion clips are not yet read by this connection.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Blink motion clips are not yet read by this connection.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'lostblink does not record.');
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'lostblink does not record.');
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
