/**
 * Reolink cameras and NVRs, over their local HTTP API and RTSP.
 *
 * Reolink exposes a local CGI at `/cgi-bin/api.cgi` that answers `GetDevInfo`
 * (model, firmware, name) and `Snap` (a JPEG still), and publishes live video
 * over RTSP. All of that works on the local network without the Reolink cloud,
 * so this provider never touches Reolink's servers — the account it uses is the
 * camera's own admin login, and it stays on your network.
 *
 * What Reolink keeps for its own app is the motion-event and SD-card recording
 * index behind a paginated, model-specific API, and PTZ behind a command set
 * that differs across the range. Rather than half-implement those and have them
 * work on one model and not the next, this provider declares snapshots and live
 * view — the two things every Reolink does the same way.
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

export const REOLINK_DESCRIPTOR: ProviderDescriptor = {
  id: 'reolink',
  displayName: 'Reolink',
  summary:
    'A Reolink camera or NVR on your own network, over its local API and RTSP. Snapshots and live view — Reolink keeps motion events, recordings and PTZ behind its own app API.',
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
      placeholder: 'http://192.168.1.60',
      help: 'The camera or NVR on your network. Use http:// unless you have enabled HTTPS on it.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Driveway',
      help: 'What this camera is called in the app. Defaults to the name the camera reports.',
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      required: true,
      placeholder: 'admin',
      help: 'A camera login. A dedicated viewer-only account is safer than the admin one.',
    },
    {
      key: 'password',
      label: 'Password',
      type: 'secret',
      required: true,
      help: 'Stored encrypted. Used only to reach the camera on your network.',
    },
    {
      key: 'channel',
      label: 'Channel',
      type: 'number',
      required: false,
      default: 0,
      advanced: true,
      help: 'For an NVR, which camera channel to use (0 is the first). A standalone camera is 0.',
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
      default: 554,
      advanced: true,
      help: 'Only change this if you have moved the camera off the standard RTSP port.',
    },
  ],
};

interface DevInfoResponse {
  cmd?: string;
  code?: number;
  value?: { DevInfo?: { model?: string; firmVer?: string; name?: string } };
  error?: { detail?: string; rspCode?: number };
}

export class ReolinkProvider implements CameraProvider {
  readonly descriptor = REOLINK_DESCRIPTOR;
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

  get #channel(): number {
    const n = Number(this.#ctx.settings.channel ?? 0);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  get #streamKind(): 'main' | 'sub' {
    return String(this.#ctx.settings.stream ?? 'main').trim() === 'sub' ? 'sub' : 'main';
  }

  get #rtspPort(): number {
    const n = Number(this.#ctx.settings.rtspPort ?? 554);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 554;
  }

  get #cameraId(): string {
    return `channel-${this.#channel}`;
  }

  /** Builds a CGI URL with credentials in the query, as Reolink's API expects. */
  #apiUrl(cmd: string, extra: Record<string, string> = {}): string {
    const url = new URL(this.#baseUrl.toString());
    url.pathname = '/cgi-bin/api.cgi';
    url.searchParams.set('cmd', cmd);
    url.searchParams.set('user', this.#username);
    url.searchParams.set('password', this.#ctx.secrets.password ?? '');
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    return url.toString();
  }

  async #devInfo(): Promise<DevInfoResponse | null> {
    const url = this.#apiUrl('GetDevInfo');
    const response = await this.#ctx.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ cmd: 'GetDevInfo', param: {} }]),
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError('UPSTREAM_ERROR', `Reolink returned HTTP ${response.status}.`);
    }
    const body = (await response.json()) as DevInfoResponse[] | DevInfoResponse;
    const entry = Array.isArray(body) ? body[0] : body;
    return entry ?? null;
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
      if (info?.error || info?.code !== 0) {
        return {
          ok: false,
          message: 'The camera rejected the login. Check the username and password.',
          cameraCount: null,
          latencyMs: Date.now() - started,
        };
      }
      const model = info.value?.DevInfo?.model ?? 'Reolink';
      return {
        ok: true,
        message: `Reached ${model}.`,
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
    let info: DevInfoResponse | null = null;
    try {
      info = await this.#devInfo();
    } catch {
      // Reachability is the probe's job; a failure here still yields a camera
      // entry so the source is listable, just with unknown health.
      info = null;
    }
    return [this.#camera(info)];
  }

  async getCamera(cameraId: string): Promise<Camera> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    return (await this.listCameras())[0]!;
  }

  #camera(info: DevInfoResponse | null): Camera {
    const dev = info?.value?.DevInfo;
    const reachable = Boolean(dev) && info?.code === 0;
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return {
      id: this.#cameraId,
      name: configured || dev?.name || 'Reolink camera',
      location: null,
      group: null,
      model: dev?.model ?? 'Reolink',
      firmware: dev?.firmVer ?? null,
      capabilities: {
        // PTZ, spotlight and siren exist on some models but through commands
        // that vary across the range; advertising them here would light up
        // buttons that fail on tap.
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        // Reolink streams carry audio, but whether this one does is only
        // knowable once the stream is open.
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
    // `rs` is a cache-buster Reolink's own app sends; without it some firmware
    // serves a stale frame.
    const url = this.#apiUrl('Snap', {
      channel: String(this.#channel),
      rs: Date.now().toString(36),
    });
    const response = await this.#ctx.fetchImpl(url, {
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError('CAMERA_OFFLINE', `Could not capture a frame (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      // A JSON body here is Reolink's way of reporting an auth or channel
      // error; forwarding it as an image would corrupt the snapshot.
      throw new AppError(
        'CAMERA_OFFLINE',
        'The camera did not return an image. Check the login and channel.',
      );
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
    // Reolink's RTSP path numbers channels from 1 with two digits, so API
    // channel 0 is `_01_`. Credentials go in the URL because RTSP has no other
    // way to authenticate; the session is minted per request, returned only to
    // an authenticated caller, and never logged.
    const rtspChannel = String(this.#channel + 1).padStart(2, '0');
    const url = new URL(`rtsp://${this.#baseUrl.hostname}`);
    url.port = String(this.#rtspPort);
    url.username = encodeURIComponent(this.#username);
    url.password = encodeURIComponent(password);
    url.pathname = `/h264Preview_${rtspChannel}_${this.#streamKind}`;

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
      'Reolink PTZ and light commands vary by model and are not exposed by this connection.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Reolink motion events are read through its app.');
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Reolink motion events are read through its app.');
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Reolink SD-card and NVR recordings are reached through its own app.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Reolink SD-card and NVR recordings are reached through its own app.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
