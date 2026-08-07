/**
 * Wyze cameras, through a docker-wyze-bridge instance.
 *
 * Wyze has no supported local API and no official third-party one; the bridge
 * is what makes these cameras usable at all, terminating Wyze's protocol and
 * republishing each camera as ordinary RTSP/HLS/WebRTC. This provider talks to
 * the bridge, never to Wyze — so no Wyze account credential is held here.
 *
 * The bridge's `/api/cameras` shape has changed across releases (a bare list in
 * older builds, `{cameras: {...}}` in newer ones). Both are read, because
 * pinning to one would break silently on upgrade with an empty camera list
 * rather than an error.
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

/** Where the shipped bridge template publishes, and so the sensible default. */
const DEFAULT_BRIDGE_URL = 'http://wyze-bridge:5000';

export const WYZE_DESCRIPTOR: ProviderDescriptor = {
  id: 'wyze',
  displayName: 'Wyze (docker-wyze-bridge)',
  summary:
    'Wyze cameras republished by a docker-wyze-bridge instance. Live view and snapshots. Wyze motion events and cloud clips stay in the Wyze app.',
  capabilities: {
    snapshots: true,
    liveStream: true,
    // The bridge relays video, not Wyze's event history — that lives in Wyze's
    // cloud behind an account session this connection deliberately never holds.
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
      label: 'Bridge address',
      type: 'url',
      // Not required: a bridge Orionis provisions does not exist yet when the
      // connection is created, and the applier writes this key afterwards. The
      // default covers the ordinary case of one bridge beside the gateway, so
      // the box is never actually empty.
      required: false,
      placeholder: DEFAULT_BRIDGE_URL,
      default: DEFAULT_BRIDGE_URL,
      help: 'The docker-wyze-bridge web interface, reachable from this gateway.',
    },
    {
      key: 'streamBaseUrl',
      label: 'Stream address',
      type: 'url',
      required: false,
      advanced: true,
      placeholder: 'http://wyze-bridge:8888',
      help: "The bridge's HLS port, if it differs from the address above.",
    },
    {
      key: 'apiKey',
      label: 'Bridge API key',
      type: 'secret',
      required: false,
      advanced: true,
      help: 'Only if the bridge was started with WB_API_KEY. Stored encrypted.',
    },
  ],
  bridge: {
    template: 'wyze',
    summary:
      'Wyze cameras only reach this gateway through a docker-wyze-bridge. Orionis can start one, generate its API key, and point this connection at it.',
    provides: ['baseUrl', 'streamBaseUrl'],
    // The bridge refuses API calls without a key. Minting it here and handing
    // it down means the gateway already holds the credential it will need,
    // rather than fishing it back out of a container's logs.
    mints: ['apiKey'],
  },
};

interface WyzeBridgeCamera {
  name_uri?: string;
  nickname?: string;
  name?: string;
  model_name?: string;
  product_model?: string;
  firmware_ver?: string;
  connected?: boolean;
  enabled?: boolean;
  status?: string;
  audio?: boolean;
  hls_url?: string;
  rtsp_url?: string;
  webrtc_url?: string;
  img_url?: string;
}

export class WyzeProvider implements CameraProvider {
  readonly descriptor = WYZE_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #baseUrl(): string {
    return String(this.#ctx.settings.baseUrl ?? '').replace(/\/+$/, '') || DEFAULT_BRIDGE_URL;
  }

  get #streamBaseUrl(): string {
    const explicit = String(this.#ctx.settings.streamBaseUrl ?? '').replace(/\/+$/, '');
    return explicit || this.#baseUrl;
  }

  /** The bridge authenticates API calls with a query parameter, not a header. */
  #url(path: string): string {
    const apiKey = this.#ctx.secrets.apiKey;
    if (!apiKey) return `${this.#baseUrl}${path}`;
    const separator = path.includes('?') ? '&' : '?';
    return `${this.#baseUrl}${path}${separator}api=${encodeURIComponent(apiKey)}`;
  }

  async #cameras(): Promise<Record<string, WyzeBridgeCamera>> {
    const response = await this.#ctx.fetchImpl(this.#url('/api/cameras'), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AppError('UPSTREAM_ERROR', 'The bridge rejected the API key.');
      }
      throw new AppError('UPSTREAM_ERROR', `The bridge returned HTTP ${response.status}.`);
    }

    const body = (await response.json()) as
      | WyzeBridgeCamera[]
      | { cameras?: Record<string, WyzeBridgeCamera> }
      | Record<string, WyzeBridgeCamera>;

    // Newest shape first, then the wrapped map, then the historical list.
    if (Array.isArray(body)) {
      const out: Record<string, WyzeBridgeCamera> = {};
      for (const camera of body) {
        const id = camera.name_uri ?? camera.name;
        if (id) out[id] = camera;
      }
      return out;
    }
    if (body && typeof body === 'object' && 'cameras' in body && body.cameras) {
      return body.cameras as Record<string, WyzeBridgeCamera>;
    }
    return (body ?? {}) as Record<string, WyzeBridgeCamera>;
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const cameras = await this.#cameras();
      const entries = Object.values(cameras);
      const online = entries.filter((c) => c.connected !== false).length;
      return {
        ok: true,
        message:
          entries.length === 0
            ? 'Reached the bridge, but it has no cameras yet.'
            : `Connected to the bridge; ${online} of ${entries.length} camera(s) online.`,
        cameraCount: entries.length,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The bridge could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    const cameras = await this.#cameras();
    return Object.entries(cameras).map(([id, camera]) => this.#camera(id, camera));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const cameras = await this.#cameras();
    const camera = cameras[cameraId];
    if (!camera) throw AppError.notFound('Camera');
    return this.#camera(cameraId, camera);
  }

  #camera(id: string, camera: WyzeBridgeCamera): Camera {
    const enabled = camera.enabled !== false;
    const connected = camera.connected === true;
    return {
      id,
      name: camera.nickname ?? camera.name ?? id.replace(/[_-]+/g, ' '),
      location: null,
      group: null,
      model: camera.model_name ?? camera.product_model ?? null,
      firmware: camera.firmware_ver ?? null,
      capabilities: {
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        audio: camera.audio ?? null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: true,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        status: !enabled ? 'offline' : connected ? 'online' : 'degraded',
        recording: null,
        streaming: connected,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: !enabled
          ? 'This camera is switched off in the bridge.'
          : connected
            ? null
            : // Battery and low-power Wyze cameras spend most of their life
              // disconnected on purpose; that is not a fault.
              (camera.status ?? 'The bridge is not currently connected to this camera.'),
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    const response = await this.#ctx.fetchImpl(
      this.#url(`/snapshot/${encodeURIComponent(cameraId)}.jpg`),
      { signal: AbortSignal.timeout(this.#ctx.timeoutMs) },
    );
    if (!response.ok) {
      throw new AppError(
        'CAMERA_OFFLINE',
        `The bridge could not capture a frame (HTTP ${response.status}).`,
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
    const cameras = await this.#cameras();
    const camera = cameras[input.cameraId];
    if (!camera) throw AppError.notFound('Camera');

    // The bridge tells us where it publishes; only fall back to constructing a
    // URL when it does not, since its layout has changed between releases.
    const playbackUrl =
      camera.hls_url ??
      `${this.#streamBaseUrl}/${encodeURIComponent(input.cameraId)}/${encodeURIComponent(input.cameraId)}.m3u8`;

    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      playbackUrl,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // The bridge stops the upstream connection on its own once nobody is
    // watching; tearing it down here would fight that.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Camera controls are not wired for bridge connections.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Wyze keeps motion events in its own cloud, which this connection does not sign in to.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Wyze keeps motion events in its own cloud, which this connection does not sign in to.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'The bridge relays live video; it does not record.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'The bridge relays live video; it does not record.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
