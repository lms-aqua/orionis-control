/**
 * Ring cameras and doorbells, through a ring-mqtt bridge.
 *
 * Ring has no local API and no official third-party one; tsightler/ring-mqtt is
 * the community bridge that signs in to Ring (owning the 2FA flow through its
 * own web app) and republishes each camera as RTSP through an embedded go2rtc.
 * This provider talks only to that bridge's RTSP endpoint — no Ring credential
 * is ever held here.
 *
 * The bridge's stable, documented interface is RTSP on port 8554, one path per
 * camera: `<device_id>_live` for the live view and `<device_id>_event` for the
 * last recorded event. Its go2rtc HTTP API is deliberately disabled, and camera
 * discovery happens over MQTT — neither of which this gateway consumes — so the
 * cameras are listed from the device ids the operator copies out of the
 * ring-mqtt web UI. Snapshots are published by the bridge over MQTT only, with
 * no HTTP equivalent, so this provider is honestly live-view only.
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

/** Where the shipped bridge template publishes its RTSP server. */
const DEFAULT_RTSP_URL = 'rtsp://ring-mqtt:8554';

export const RING_DESCRIPTOR: ProviderDescriptor = {
  id: 'ring',
  displayName: 'Ring (ring-mqtt)',
  summary:
    'Ring cameras and doorbells republished by a ring-mqtt bridge. Live view only — Ring keeps snapshots, motion events and recordings behind its cloud, which the bridge exposes over MQTT rather than to this gateway.',
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
      key: 'rtspBaseUrl',
      label: 'Bridge RTSP address',
      type: 'url',
      // Not required: a bridge Orionis provisions does not exist when the
      // connection is created, and the applier writes this key afterwards. The
      // default covers the ordinary case of one bridge beside the gateway.
      required: false,
      placeholder: DEFAULT_RTSP_URL,
      default: DEFAULT_RTSP_URL,
      help: 'The ring-mqtt RTSP server, reachable from this gateway. Port 8554 unless you changed it.',
    },
    {
      key: 'cameras',
      label: 'Cameras',
      type: 'text',
      required: true,
      placeholder: 'Front Door=3452b19184fa\nDriveway=a1b2c3d4e5f6',
      help: 'One Name=device-id per line. Copy each camera’s device id from the ring-mqtt web interface.',
    },
    {
      key: 'streamType',
      label: 'Stream',
      type: 'text',
      required: false,
      default: 'live',
      advanced: true,
      help: 'live is the current view. event plays back the last recorded motion/ding event.',
    },
    {
      key: 'refreshToken',
      label: 'Ring refresh token',
      type: 'secret',
      required: false,
      help:
        'Only needed if Orionis starts the bridge for you. Generate one with ' +
        '`npx -p ring-client-api ring-auth-cli` — Ring sends a code, and the tool ' +
        'prints a token. Stored encrypted, and handed to the bridge so it never ' +
        'has to ask for a code of its own.',
    },
    {
      key: 'username',
      label: 'RTSP username',
      type: 'text',
      required: false,
      advanced: true,
      help: 'Only if the bridge was configured to require RTSP credentials. Usually blank.',
    },
    {
      key: 'password',
      label: 'RTSP password',
      type: 'secret',
      required: false,
      advanced: true,
      help: 'Stored encrypted. Only if the bridge requires RTSP credentials.',
    },
  ],
  bridge: {
    template: 'ring-mqtt',
    summary:
      'Ring cameras only reach this gateway through a ring-mqtt bridge. Orionis can start one — give it a Ring refresh token above, and add each camera’s device id, which the bridge logs on its first run.',
    provides: ['rtspBaseUrl'],
    // ring-mqtt earns its own session through a browser flow on port 55123.
    // Publishing that would put a Ring account auth page on the LAN, so the
    // token is handed over instead and the port stays closed — the same trade
    // the Blink bridge makes, for the same reason.
    handsOver: { secrets: ['refreshToken'] },
  },
};

interface RingCameraEntry {
  name: string;
  deviceId: string;
}

export class RingProvider implements CameraProvider {
  readonly descriptor = RING_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #rtspBase(): string {
    const raw = String(this.#ctx.settings.rtspBaseUrl ?? '').trim();
    return (raw || DEFAULT_RTSP_URL).replace(/\/+$/, '');
  }

  get #streamSuffix(): 'live' | 'event' {
    return String(this.#ctx.settings.streamType ?? 'live').trim() === 'event' ? 'event' : 'live';
  }

  /** Parses the `Name=device-id` block, ignoring blanks and comments. A line
   * with no `=` is treated as a bare device id and named after it. */
  get #cameras(): RingCameraEntry[] {
    return String(this.#ctx.settings.cameras ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const idx = line.indexOf('=');
        if (idx <= 0) return { name: line, deviceId: line };
        return { name: line.slice(0, idx).trim(), deviceId: line.slice(idx + 1).trim() };
      })
      .filter((entry) => Boolean(entry.deviceId));
  }

  async probe(): Promise<ProbeResult> {
    const count = this.#cameras.length;
    // The bridge's RTSP server cannot be meaningfully reached with a plain
    // fetch, so — as with the manual RTSP source — this reports what is
    // configured and says the stream itself is checked when live view opens.
    return {
      ok: count > 0,
      message:
        count > 0
          ? `${count} Ring camera(s) configured. Each is checked when its live view opens.`
          : 'No cameras are configured. Add one Name=device-id per line.',
      cameraCount: count > 0 ? count : null,
      latencyMs: null,
    };
  }

  async listCameras(): Promise<Camera[]> {
    return this.#cameras.map((entry) => this.#camera(entry));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const entry = this.#cameras.find((c) => c.deviceId === cameraId);
    if (!entry) throw AppError.notFound('Camera');
    return this.#camera(entry);
  }

  #camera(entry: RingCameraEntry): Camera {
    return {
      id: entry.deviceId,
      name: entry.name,
      location: null,
      group: null,
      model: 'Ring',
      firmware: null,
      capabilities: {
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        // Ring streams carry audio, but whether a given one does is only
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
        // Battery Ring cameras sleep between events, so the bridge cannot prove
        // one is up until a stream is opened; "unknown" is the honest state.
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
        message: 'Ring cameras report nothing until a stream is opened.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'ring-mqtt publishes snapshots over MQTT only; there is no still image to fetch here.',
    );
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    const entry = this.#cameras.find((c) => c.deviceId === input.cameraId);
    if (!entry) throw AppError.notFound('Camera');

    // The bridge serves `<device_id>_live` / `_event` on its RTSP port.
    // Credentials, if the bridge requires them, go in the URL because RTSP has
    // no other way to authenticate; the session is minted per request, returned
    // only to an authenticated caller, and never logged.
    const url = new URL(this.#rtspBase);
    const username = String(this.#ctx.settings.username ?? '').trim();
    const password = this.#ctx.secrets.password ?? '';
    if (username) {
      url.username = encodeURIComponent(username);
      if (password) url.password = encodeURIComponent(password);
    }
    url.pathname = `/${entry.deviceId}_${this.#streamSuffix}`;

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
    // The bridge stops the upstream Ring connection once nobody is watching;
    // tearing it down here would fight that.
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
      'Ring keeps motion events in its cloud; the bridge exposes them over MQTT, not to this gateway.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Ring keeps motion events in its cloud; the bridge exposes them over MQTT, not to this gateway.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Ring recordings live in its cloud (a Ring Protect plan); this connection does not sign in to it.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Ring recordings live in its cloud (a Ring Protect plan); this connection does not sign in to it.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
