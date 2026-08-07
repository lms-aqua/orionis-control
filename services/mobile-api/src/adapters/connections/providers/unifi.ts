/**
 * UniFi Protect, through its local integration API.
 *
 * Protect exposes a first-class, documented API on the console itself
 * (`/proxy/protect/integration/v1`) authenticated with an API key created in the
 * Protect settings. That is what this speaks: no session cookies, no CSRF
 * dance, no scraping the web UI, and no cloud round trip.
 *
 * Two things about a UniFi console shape this provider:
 *
 *   - **Its certificate is self-signed** unless the operator installed their
 *     own. Node will refuse that, and the failure looks nothing like "camera
 *     offline", so the probe names it specifically rather than reporting a
 *     generic outage.
 *   - **RTSPS is per-channel and off by default.** A camera whose channels all
 *     have RTSP disabled cannot be streamed, and the honest response is to say
 *     which switch to flip rather than to hand back a URL that will not open.
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

export const UNIFI_DESCRIPTOR: ProviderDescriptor = {
  id: 'unifi',
  displayName: 'UniFi Protect',
  summary:
    'A UniFi Protect console on your network. Cameras, snapshots and live view over RTSPS. Recordings and detections stay in Protect.',
  capabilities: {
    snapshots: true,
    liveStream: true,
    // Protect's detections arrive over a websocket rather than a listable
    // endpoint on the integration API; until that is read, claiming events
    // would mean returning an empty history that reads as "nothing happened".
    events: false,
    eventDetection: false,
    recordings: false,
    controls: false,
    storageReporting: false,
    interactiveAuth: false,
  },
  fields: [
    {
      key: 'baseUrl',
      label: 'Console address',
      type: 'url',
      required: true,
      placeholder: 'https://unifi.local',
      help: 'Your UniFi console. Its certificate must be one this server trusts.',
    },
    {
      key: 'apiKey',
      label: 'Protect API key',
      type: 'secret',
      required: true,
      help: 'Create one in Protect → Settings → Control Plane → Integrations. Stored encrypted.',
    },
    {
      key: 'rtspPort',
      label: 'RTSPS port',
      type: 'number',
      required: false,
      default: 7441,
      help: 'Protect publishes streams here. Change only if your console does.',
    },
  ],
};

interface UnifiChannel {
  id?: number;
  name?: string;
  isRtspEnabled?: boolean;
  rtspAlias?: string | null;
  width?: number;
  height?: number;
  fps?: number;
}

interface UnifiCamera {
  id: string;
  name?: string;
  state?: string;
  type?: string;
  modelKey?: string;
  firmwareVersion?: string;
  isConnected?: boolean;
  isRecording?: boolean;
  featureFlags?: { hasMic?: boolean; hasLedStatus?: boolean; canOpticalZoom?: boolean };
  channels?: UnifiChannel[];
}

export class UnifiProvider implements CameraProvider {
  readonly descriptor = UNIFI_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #baseUrl(): string {
    const raw = String(this.#ctx.settings.baseUrl ?? '').replace(/\/+$/, '');
    if (!raw) throw new AppError('SERVICE_NOT_CONFIGURED', 'No console address is set.');
    return raw;
  }

  get #rtspPort(): number {
    const raw = Number(this.#ctx.settings.rtspPort ?? 7441);
    return Number.isFinite(raw) && raw > 0 && raw < 65_536 ? raw : 7441;
  }

  async #get<T>(path: string): Promise<T> {
    const response = await this.#request(path);
    if (!response.ok) throw this.#httpError(response.status);
    return (await response.json()) as T;
  }

  async #request(path: string): Promise<Response> {
    const apiKey = this.#ctx.secrets.apiKey;
    if (!apiKey) {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'No Protect API key is set.');
    }
    return this.#ctx.fetchImpl(`${this.#baseUrl}/proxy/protect/integration/v1${path}`, {
      headers: { 'X-API-KEY': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
  }

  #httpError(status: number): AppError {
    if (status === 401 || status === 403) {
      return new AppError(
        'UPSTREAM_ERROR',
        'Protect rejected the API key. Check that it is still listed under Integrations.',
      );
    }
    if (status === 404) {
      return new AppError(
        'UPSTREAM_ERROR',
        'This console did not answer on the Protect integration API. It needs a recent Protect version.',
      );
    }
    return new AppError('UPSTREAM_ERROR', `Protect returned HTTP ${status}.`);
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const cameras = await this.#get<UnifiCamera[]>('/cameras');
      const connected = cameras.filter((c) => c.isConnected !== false).length;
      return {
        ok: true,
        message: `Connected to Protect; ${connected} of ${cameras.length} camera(s) online.`,
        cameraCount: cameras.length,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Protect could not be reached.';
      return {
        ok: false,
        // A rejected certificate is the single most common first-run failure on
        // a UniFi console, and it is not an outage — saying so saves an hour.
        message: /certificate|self-signed|SSL|TLS/i.test(message)
          ? 'The console presented a certificate this server does not trust. Install a trusted certificate on the console, or add its CA to this server.'
          : message,
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    return (await this.#get<UnifiCamera[]>('/cameras')).map((c) => this.#camera(c));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    return this.#camera(await this.#get<UnifiCamera>(`/cameras/${encodeURIComponent(cameraId)}`));
  }

  #camera(camera: UnifiCamera): Camera {
    const connected = camera.isConnected !== false;
    const best = this.#bestChannel(camera);
    return {
      id: camera.id,
      name: camera.name ?? camera.id,
      location: null,
      group: null,
      model: camera.type ?? camera.modelKey ?? null,
      firmware: camera.firmwareVersion ?? null,
      capabilities: {
        // Protect's PTZ and light controls exist, but through endpoints this
        // connection does not call yet; declaring them would mean a button that
        // does nothing.
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        audio: camera.featureFlags?.hasMic ?? null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: true,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        status: connected ? 'online' : 'offline',
        // Protect knows this one for certain, unlike most upstreams here.
        recording: camera.isRecording ?? null,
        streaming: connected && best !== null,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: best?.fps ?? null,
        resolution: best?.width && best?.height ? `${best.width}x${best.height}` : null,
        message: !connected
          ? 'Protect reports this camera as disconnected.'
          : best === null
            ? 'RTSP is switched off for every channel on this camera, so it cannot be streamed. Enable it in Protect → camera → Manage → RTSP.'
            : null,
      },
      snapshotPath: null,
    };
  }

  /** The highest-resolution channel that is actually published over RTSPS. */
  #bestChannel(camera: UnifiCamera): UnifiChannel | null {
    const usable = (camera.channels ?? []).filter((c) => c.isRtspEnabled && c.rtspAlias);
    if (usable.length === 0) return null;
    return usable.sort(
      (a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
    )[0]!;
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    const response = await this.#request(
      `/cameras/${encodeURIComponent(cameraId)}/snapshot?highQuality=true`,
    );
    if (!response.ok) {
      if (response.status === 404) throw AppError.notFound('Camera');
      throw new AppError(
        'CAMERA_OFFLINE',
        `Protect could not return a frame (HTTP ${response.status}).`,
      );
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
    const camera = await this.#get<UnifiCamera>(`/cameras/${encodeURIComponent(input.cameraId)}`);
    const channel = this.#bestChannel(camera);
    if (!channel?.rtspAlias) {
      throw new AppError(
        'STREAM_UNAVAILABLE',
        'RTSP is switched off for every channel on this camera. Enable it in Protect → camera → Manage → RTSP.',
      );
    }

    const host = new URL(this.#baseUrl).hostname;
    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      // Protect serves RTSPS on its own port, independent of the console's web
      // interface, and the alias is the only credential it needs.
      playbackUrl: `rtsps://${host}:${this.#rtspPort}/${channel.rtspAlias}?enableSrtp`,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // Protect holds no per-viewer handle for an RTSPS alias.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Camera controls are not yet wired for UniFi Protect connections.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Protect publishes detections over a live websocket rather than a history this connection can page through.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Protect publishes detections over a live websocket rather than a history this connection can page through.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Protect keeps its recordings on the console; this connection does not export them.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Protect keeps its recordings on the console; this connection does not export them.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
