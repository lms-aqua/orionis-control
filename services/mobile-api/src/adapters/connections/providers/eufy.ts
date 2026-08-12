/**
 * Eufy Security cameras, through a eufy-security-ws bridge.
 *
 * Eufy has no local API; bropat/eufy-security-ws is the community bridge that
 * signs in to the Eufy cloud (owning the captcha / 2FA flow) and exposes the
 * account over a WebSocket. This provider talks only to that bridge — no Eufy
 * credential is ever held here — using the small client in `lib/eufy-ws.ts`.
 *
 * What the bridge gives us per camera is a `pictureUrl` (the last still image,
 * a signed cloud URL) and, for cameras that support local RTSP, a
 * `rtspStreamUrl`. Snapshots use the former; live view uses the latter, asking
 * the bridge to start RTSP first when it is not already running. Events,
 * recordings and controls live behind the bridge's own command surface and are
 * not wired here.
 *
 * Verified against the bridge's documented protocol and unit-tested with a
 * scripted socket; the live path to a real Eufy account is the one thing only
 * an operator with the bridge can confirm.
 */
import { AppError } from '../../../lib/errors.ts';
import { assertSafeUpstreamUrl } from '../../../lib/upstream-url.ts';
import {
  EufyWsSession,
  EufyWsError,
  type EufyWsDevice,
  type WebSocketCtor,
} from '../../../lib/eufy-ws.ts';
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

const DEFAULT_WS_URL = 'ws://eufy-security-ws:3000';

export const EUFY_DESCRIPTOR: ProviderDescriptor = {
  id: 'eufy',
  displayName: 'Eufy Security (eufy-security-ws)',
  summary:
    'Eufy cameras and doorbells through a eufy-security-ws bridge. Live view for cameras that support local RTSP, plus last-image snapshots. Events and recordings stay in the Eufy cloud.',
  capabilities: {
    snapshots: true,
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
      key: 'wsUrl',
      label: 'Bridge address',
      // Text rather than url: this is a ws:// address, which the URL field
      // validator (HTTP/RTSP only) would reject. It is validated in-provider
      // against ws/wss and the same metadata/link-local blocks.
      type: 'text',
      required: false,
      placeholder: DEFAULT_WS_URL,
      default: DEFAULT_WS_URL,
      help: 'The eufy-security-ws WebSocket, reachable from this gateway. Usually ws://…:3000.',
    },
    // The bridge signs in to Eufy on its own behalf. Before these existed the
    // connection held nothing to hand it, so a provisioned bridge started with
    // no account and sat there unable to reach anything.
    {
      key: 'email',
      label: 'Eufy email',
      type: 'text',
      required: false,
      help: 'Only needed if Orionis starts the bridge for you — it signs in to Eufy with this. Leave blank when pointing at a bridge that is already signed in.',
    },
    {
      key: 'password',
      label: 'Eufy password',
      type: 'secret',
      required: false,
      help: 'Stored encrypted, and handed to the bridge rather than used from here. This gateway never signs in to Eufy itself.',
    },
    {
      key: 'country',
      label: 'Country',
      type: 'text',
      required: false,
      default: 'US',
      advanced: true,
      help: 'Two-letter code for the Eufy region the account belongs to. A sign-in aimed at the wrong region is rejected.',
    },
  ],
  bridge: {
    template: 'eufy-security-ws',
    summary:
      'Eufy cameras only reach this gateway through a eufy-security-ws bridge. Orionis can start one and sign it in with the account above. An account with two-factor enabled will need the emailed code entered at the bridge itself the first time.',
    provides: ['wsUrl'],
    // The bridge signs in to Eufy on its own behalf, so it needs the same
    // account the connection holds — the Wyze arrangement exactly.
    handsOver: { settings: ['email', 'country'], secrets: ['password'] },
  },
};

/** A device is treated as a camera when it carries any streaming/imaging
 * signal — locks, sensors and keypads have none of these. */
function isCamera(device: EufyWsDevice): boolean {
  return (
    'rtspStream' in device ||
    typeof device.rtspStreamUrl === 'string' ||
    typeof device.pictureUrl === 'string'
  );
}

export class EufyProvider implements CameraProvider {
  readonly descriptor = EUFY_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #wsUrl(): string {
    const raw = String(this.#ctx.settings.wsUrl ?? '').trim() || DEFAULT_WS_URL;
    // ws:// is not a URL-field type, so the create-time validator skips it;
    // enforce scheme and the metadata/link-local blocks here instead.
    return assertSafeUpstreamUrl(raw, 'Bridge address', { protocols: ['ws:', 'wss:'] });
  }

  get #wsCtor(): WebSocketCtor {
    const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!ctor) {
      throw new AppError(
        'SERVICE_NOT_CONFIGURED',
        'This runtime has no WebSocket support, which the Eufy bridge requires.',
      );
    }
    return ctor;
  }

  async #withSession<T>(fn: (session: EufyWsSession) => Promise<T>): Promise<T> {
    try {
      return await EufyWsSession.run(this.#wsUrl, this.#ctx.timeoutMs, this.#wsCtor, fn);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof EufyWsError) {
        throw new AppError('UPSTREAM_ERROR', error.message);
      }
      throw new AppError('UPSTREAM_UNAVAILABLE', 'The Eufy bridge could not be reached.');
    }
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const cameras = (await this.#withSession((s) => s.listDevices())).filter(isCamera);
      return {
        ok: true,
        message:
          cameras.length > 0
            ? `Connected to the bridge; ${cameras.length} camera(s) found.`
            : 'Reached the bridge, but it reported no cameras. Finish signing in to Eufy in the bridge.',
        cameraCount: cameras.length,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof AppError ? error.message : 'The bridge could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    const devices = (await this.#withSession((s) => s.listDevices())).filter(isCamera);
    return devices.map((device) => this.#camera(device));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const device = (await this.#withSession((s) => s.listDevices())).find(
      (d) => d.serialNumber === cameraId,
    );
    if (!device || !isCamera(device)) throw AppError.notFound('Camera');
    return this.#camera(device);
  }

  #camera(device: EufyWsDevice): Camera {
    return {
      id: device.serialNumber,
      name: device.name ?? device.serialNumber,
      location: null,
      group: null,
      model: device.model ?? 'Eufy',
      firmware: null,
      capabilities: {
        ptz: false,
        presets: false,
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
        snapshot: typeof device.pictureUrl === 'string',
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        // Most Eufy cameras are battery devices that sleep between events, so
        // the bridge cannot assert one is live until a stream opens.
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
        message: 'Eufy cameras report nothing until a stream is opened.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    const device = (await this.#withSession((s) => s.listDevices())).find(
      (d) => d.serialNumber === cameraId,
    );
    if (!device) throw AppError.notFound('Camera');
    if (typeof device.pictureUrl !== 'string' || !device.pictureUrl) {
      throw new AppError(
        'CAMERA_OFFLINE',
        'The bridge has no recent image for this camera yet. Open live view or wait for a motion event.',
      );
    }
    // pictureUrl is a signed cloud URL for the last still; fetch it directly.
    const response = await this.#ctx.fetchImpl(device.pictureUrl, {
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError(
        'CAMERA_OFFLINE',
        `Could not fetch the last image (HTTP ${response.status}).`,
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
    const playbackUrl = await this.#withSession(async (session) => {
      const device = (await session.listDevices()).find((d) => d.serialNumber === input.cameraId);
      if (!device) throw AppError.notFound('Camera');

      // Already streaming: use the URL the bridge reported.
      if (typeof device.rtspStreamUrl === 'string' && device.rtspStreamUrl) {
        return device.rtspStreamUrl;
      }
      // Otherwise ask the bridge to start RTSP, then read the URL back.
      await session.startRtsp(input.cameraId);
      const props = await session.getProperties(input.cameraId);
      const url = props.rtspStreamUrl;
      if (typeof url !== 'string' || !url) {
        throw new AppError(
          'CAPABILITY_UNSUPPORTED',
          'This Eufy camera did not return an RTSP stream. RTSP must be enabled for it (a HomeBase-connected camera that supports local RTSP).',
        );
      }
      return url;
    });

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
    // The bridge stops the upstream connection once nobody is watching.
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
      'Eufy keeps motion events behind the bridge’s own command surface, which this connection does not consume.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Eufy keeps motion events behind the bridge’s own command surface, which this connection does not consume.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Eufy recordings live on the HomeBase / in the Eufy cloud, reached through the bridge, not this gateway.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Eufy recordings live on the HomeBase / in the Eufy cloud, reached through the bridge, not this gateway.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
