/**
 * Arlo cameras, through an arlo-cam-api bridge.
 *
 * Arlo's cloud has no usable third-party API, but base-station Arlo cameras
 * (the ones that pair to a VMB hub) speak a local protocol that the community
 * bridge Meatballs1/arlo-cam-api terminates on your own network. This provider
 * talks only to that bridge over its local HTTP API — nothing here contacts
 * Arlo's cloud, and there is no Arlo account credential to hold, because the
 * bridge authenticates at the network layer by standing in for the base station.
 *
 * The bridge lists cameras at `GET /camera` (each with its `ip`, `serial_number`
 * and `friendly_name`), and a camera serves RTSP at `rtsp://<ip>/live` once its
 * stream is switched on with `POST /camera/<serial>/userstreamactive {active:1}`.
 * Snapshots are a push flow (the camera uploads to a callback) with no
 * synchronous "give me a still" endpoint, so this provider is honestly
 * live-view only.
 *
 * Verified against the bridge's documented HTTP API; the live path to a real
 * base station is the part only an operator with the hardware can confirm.
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

/** Where the shipped bridge template publishes its HTTP API. */
const DEFAULT_BRIDGE_URL = 'http://arlo-cam-api:5000';

export const ARLO_DESCRIPTOR: ProviderDescriptor = {
  id: 'arlo',
  displayName: 'Arlo (arlo-cam-api)',
  summary:
    'Base-station Arlo cameras through an arlo-cam-api bridge on your own network. Live view only — Arlo keeps snapshots, motion events and cloud clips off this local path.',
  capabilities: {
    snapshots: false,
    liveStream: true,
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
      // Not required: a bridge Orionis provisions does not exist when the
      // connection is created, and the applier writes this key afterwards. The
      // default covers the ordinary case of one bridge beside the gateway.
      required: false,
      placeholder: DEFAULT_BRIDGE_URL,
      default: DEFAULT_BRIDGE_URL,
      help: 'The arlo-cam-api HTTP API, reachable from this gateway. Port 5000 unless you changed it.',
    },
    {
      key: 'rtspPort',
      label: 'RTSP port',
      type: 'number',
      required: false,
      default: 554,
      advanced: true,
      help: 'The port each Arlo camera serves RTSP on. 554 unless you changed it on the bridge.',
    },
  ],
  bridge: {
    template: 'arlo-cam-api',
    summary:
      'Arlo cameras only reach this gateway through an arlo-cam-api bridge that stands in for the Arlo base station on your network. Orionis can start one and point this connection at it.',
    provides: ['baseUrl'],
  },
};

interface ArloBridgeCamera {
  ip?: string;
  hostname?: string;
  serial_number?: string;
  friendly_name?: string;
}

export class ArloProvider implements CameraProvider {
  readonly descriptor = ARLO_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #baseUrl(): string {
    return String(this.#ctx.settings.baseUrl ?? '').replace(/\/+$/, '') || DEFAULT_BRIDGE_URL;
  }

  get #rtspPort(): number {
    const n = Number(this.#ctx.settings.rtspPort ?? 554);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 554;
  }

  async #cameras(): Promise<ArloBridgeCamera[]> {
    const response = await this.#ctx.fetchImpl(`${this.#baseUrl}/camera`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError('UPSTREAM_ERROR', `The bridge returned HTTP ${response.status}.`);
    }
    const body = (await response.json()) as ArloBridgeCamera[] | { cameras?: ArloBridgeCamera[] };
    if (Array.isArray(body)) return body;
    return body?.cameras ?? [];
  }

  #find(cameras: ArloBridgeCamera[], serial: string): ArloBridgeCamera | undefined {
    return cameras.find((c) => c.serial_number === serial);
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const cameras = await this.#cameras();
      return {
        ok: true,
        message:
          cameras.length > 0
            ? `Connected to the bridge; ${cameras.length} Arlo camera(s) paired.`
            : 'Reached the bridge, but no cameras are paired to it yet.',
        cameraCount: cameras.length,
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
    return cameras.filter((c) => c.serial_number).map((c) => this.#camera(c));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const camera = this.#find(await this.#cameras(), cameraId);
    if (!camera) throw AppError.notFound('Camera');
    return this.#camera(camera);
  }

  #camera(camera: ArloBridgeCamera): Camera {
    const id = camera.serial_number!;
    return {
      id,
      name: camera.friendly_name || camera.hostname || id,
      location: null,
      group: null,
      model: 'Arlo',
      firmware: null,
      capabilities: {
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        // Arlo streams carry audio, but whether a given one does is only
        // knowable once the stream is open.
        audio: null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: false,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        // Arlo cameras are battery devices that sleep between events, so the
        // bridge cannot prove one is live until a stream is opened.
        status: 'unknown',
        recording: null,
        streaming: false,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: 'Arlo cameras report nothing until a stream is opened.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'The Arlo bridge only pushes snapshots to a callback; there is no still image to fetch here.',
    );
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    const camera = this.#find(await this.#cameras(), input.cameraId);
    if (!camera) throw AppError.notFound('Camera');
    if (!camera.ip) {
      throw new AppError('CAMERA_OFFLINE', 'The bridge has no network address for this camera.');
    }

    // Arlo cameras only serve RTSP once their stream is switched on. Ask the
    // bridge to activate it before handing back the URL.
    const activate = await this.#ctx.fetchImpl(
      `${this.#baseUrl}/camera/${encodeURIComponent(input.cameraId)}/userstreamactive`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active: 1 }),
        signal: AbortSignal.timeout(this.#ctx.timeoutMs),
      },
    );
    if (!activate.ok) {
      throw new AppError(
        'STREAM_UNAVAILABLE',
        `The bridge could not start the camera stream (HTTP ${activate.status}).`,
      );
    }

    // The camera serves plain RTSP at /live on its own IP — no credentials, as
    // access is gated at the network layer by the bridge.
    const url = new URL(`rtsp://${camera.ip}`);
    url.port = String(this.#rtspPort);
    url.pathname = '/live';

    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      playbackUrl: url.toString(),
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // The bridge and camera wind the stream down on their own once nobody is
    // watching; there is no per-session handle to release here.
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
      'Arlo motion events are kept in its cloud, which this local bridge does not sign in to.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Arlo motion events are kept in its cloud, which this local bridge does not sign in to.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Arlo cloud clips are not reachable through the local bridge.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Arlo cloud clips are not reachable through the local bridge.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
