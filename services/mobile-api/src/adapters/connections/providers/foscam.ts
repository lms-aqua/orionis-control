/**
 * Foscam cameras, over their local CGI API and RTSP.
 *
 * Foscam exposes a local CGI at `/cgi-bin/CGIProxy.fcgi` where the command is a
 * query parameter: `getDevInfo` reports the model and firmware, `snapPicture2`
 * returns a JPEG still. Credentials are passed as `usr`/`pwd` query parameters
 * — the scheme Foscam's own clients use — so this provider does not need the
 * Digest helper. Live video is RTSP. Everything is local to your network.
 *
 * Foscam's alarm/motion log and SD-card recording index live behind further CGI
 * commands whose fields differ across models and firmware; this provider
 * declares the snapshots and live view every Foscam does the same way.
 *
 * Foscam defaults its HTTP and RTSP to port 88 rather than 80/554, which is why
 * the address field expects the port and the RTSP port defaults to 88.
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

interface FoscamDevInfo {
  ok: boolean;
  model: string | null;
  firmware: string | null;
  name: string | null;
}

export const FOSCAM_DESCRIPTOR: ProviderDescriptor = {
  id: 'foscam',
  displayName: 'Foscam',
  summary:
    'A Foscam camera on your own network, over its local CGI API and RTSP. Snapshots and live view — the motion log and SD-card recordings stay behind the camera’s own API.',
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
      key: 'baseUrl',
      label: 'Camera address',
      type: 'url',
      required: true,
      placeholder: 'http://192.168.1.50:88',
      help: 'The camera on your network, including its port. Foscam usually uses port 88, not 80.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Nursery',
      help: 'What this camera is called in the app. Defaults to the name the camera reports.',
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      required: true,
      placeholder: 'admin',
      help: 'A camera login. A visitor-level account is enough for snapshots and live view.',
    },
    {
      key: 'password',
      label: 'Password',
      type: 'secret',
      required: true,
      help: 'Stored encrypted. Used only to reach the camera on your network.',
    },
    {
      key: 'stream',
      label: 'Stream',
      type: 'text',
      required: false,
      default: 'main',
      advanced: true,
      help: 'main is full resolution. sub is a lighter copy, better over cellular.',
    },
    {
      key: 'rtspPort',
      label: 'RTSP port',
      type: 'number',
      required: false,
      default: 88,
      advanced: true,
      help: 'Foscam usually serves RTSP on port 88. Only change this if you have moved it.',
    },
  ],
};

export class FoscamProvider implements CameraProvider {
  readonly descriptor = FOSCAM_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #baseUrl(): URL {
    const raw = String(this.#ctx.settings.baseUrl ?? '').trim();
    if (!raw) throw new AppError('SERVICE_NOT_CONFIGURED', 'No camera address is set.');
    try {
      return new URL(raw);
    } catch {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The camera address is not a valid URL.');
    }
  }

  get #username(): string {
    return String(this.#ctx.settings.username ?? '').trim();
  }

  get #streamPath(): 'videoMain' | 'videoSub' {
    return String(this.#ctx.settings.stream ?? 'main').trim() === 'sub' ? 'videoSub' : 'videoMain';
  }

  get #rtspPort(): number {
    const n = Number(this.#ctx.settings.rtspPort ?? 88);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 88;
  }

  get #cameraId(): string {
    return 'camera';
  }

  /** Builds a CGIProxy URL with the command and credentials in the query. */
  #cgiUrl(cmd: string): string {
    const url = new URL(this.#baseUrl.toString());
    url.pathname = '/cgi-bin/CGIProxy.fcgi';
    url.searchParams.set('cmd', cmd);
    url.searchParams.set('usr', this.#username);
    url.searchParams.set('pwd', this.#ctx.secrets.password ?? '');
    return url.toString();
  }

  async #devInfo(): Promise<FoscamDevInfo> {
    const response = await this.#ctx.fetchImpl(this.#cgiUrl('getDevInfo'), {
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) throw new AppError('UPSTREAM_ERROR', `HTTP ${response.status}`);
    const xml = await response.text();
    const pick = (tag: string): string | null => {
      const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
      return m?.[1]?.trim() || null;
    };
    // Foscam wraps every response in <CGI_Result>; result 0 means success, and
    // a non-zero result (e.g. -2) is how it reports a bad login.
    const result = pick('result');
    return {
      ok: result === '0',
      model: pick('productName'),
      firmware: pick('firmwareVer'),
      name: pick('devName'),
    };
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    if (!this.#username || !this.#ctx.secrets.password) {
      return {
        ok: false,
        message: 'A username and password are required.',
        cameraCount: null,
        latencyMs: null,
      };
    }
    try {
      const info = await this.#devInfo();
      if (!info.ok) {
        return {
          ok: false,
          message: 'The camera rejected the login. Check the username and password.',
          cameraCount: null,
          latencyMs: Date.now() - started,
        };
      }
      return {
        ok: true,
        message: `Reached ${info.model ?? 'the camera'}.`,
        cameraCount: 1,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The camera could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    let info: FoscamDevInfo | null = null;
    try {
      info = await this.#devInfo();
    } catch {
      info = null;
    }
    return [this.#camera(info)];
  }

  async getCamera(cameraId: string): Promise<Camera> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    return (await this.listCameras())[0]!;
  }

  #camera(info: FoscamDevInfo | null): Camera {
    const reachable = Boolean(info?.ok);
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return {
      id: this.#cameraId,
      name: configured || info?.name || 'Foscam camera',
      location: null,
      group: null,
      model: info?.model ?? 'Foscam',
      firmware: info?.firmware ?? null,
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
        snapshot: true,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        status: reachable ? 'online' : 'unknown',
        recording: null,
        streaming: false,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: reachable ? null : 'Health is checked when the connection is probed.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    const response = await this.#ctx.fetchImpl(this.#cgiUrl('snapPicture2'), {
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError('CAMERA_OFFLINE', `Could not capture a frame (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      // An XML CGI_Result here means a bad login or a disabled snapshot.
      throw new AppError('CAMERA_OFFLINE', 'The camera did not return an image. Check the login.');
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType,
      capturedAt: new Date().toISOString(),
    };
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    if (input.cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    const password = this.#ctx.secrets.password ?? '';
    if (!this.#username || !password) {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The camera login is incomplete.');
    }
    // Credentials go in the URL because RTSP has no other way to authenticate;
    // the session is minted per request, returned only to an authenticated
    // caller, and never logged.
    const url = new URL(`rtsp://${this.#baseUrl.hostname}`);
    url.port = String(this.#rtspPort);
    url.username = encodeURIComponent(this.#username);
    url.password = encodeURIComponent(password);
    url.pathname = `/${this.#streamPath}`;

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
    // The session is a URL; the camera holds no handle to release.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Foscam PTZ commands vary by model and are not exposed by this connection.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Foscam motion logs are read through its own API.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Foscam motion logs are read through its own API.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Foscam SD-card recordings are reached through the camera’s own API.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Foscam SD-card recordings are reached through the camera’s own API.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
