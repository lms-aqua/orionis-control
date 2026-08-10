/**
 * Hanwha Vision (Wisenet, formerly Samsung Techwin) cameras, over their local
 * SUNAPI interface and RTSP.
 *
 * SUNAPI answers `system.cgi?msubmenu=deviceinfo` (model, firmware, name) and
 * serves a JPEG still at `video.cgi?msubmenu=snapshot`, both behind Digest
 * authentication — so this provider shares the Digest helper with the other
 * on-network sources. Live video is RTSP at Wisenet's `/profileN/media.smp`
 * paths. Nothing here contacts a Hanwha cloud.
 *
 * On most Wisenet cameras profile2 is the main stream and profile3 the sub;
 * profile1 is reserved for internal use. SUNAPI's event and recording menus
 * vary across firmware and are configured through Hanwha's own VMS, so this
 * provider declares the snapshots and live view every Wisenet does the same way.
 */
import { AppError } from '../../../lib/errors.ts';
import { fetchWithDigest } from '../../../lib/http-digest.ts';
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

interface HanwhaDeviceInfo {
  model: string | null;
  firmware: string | null;
  name: string | null;
}

export const HANWHA_DESCRIPTOR: ProviderDescriptor = {
  id: 'hanwha',
  displayName: 'Hanwha Vision (Wisenet)',
  summary:
    'A Hanwha Vision / Wisenet camera on your own network, over its local SUNAPI interface and RTSP. Snapshots and live view — events and recordings stay behind SUNAPI’s own menus.',
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
      placeholder: 'http://192.168.1.130',
      help: 'The camera on your network. Use http:// unless you have enabled HTTPS on it.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Lobby',
      help: 'What this camera is called in the app. Defaults to the name the camera reports.',
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      required: true,
      placeholder: 'admin',
      help: 'A camera login. A viewer-only account is enough for snapshots and live view.',
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
      help: 'main is full resolution (profile2). sub is a lighter copy (profile3), better over cellular.',
    },
    {
      key: 'channel',
      label: 'Channel',
      type: 'number',
      required: false,
      default: 0,
      advanced: true,
      help: 'For an encoder/recorder, which channel to snapshot (0 is the first). A standalone camera is 0.',
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

export class HanwhaProvider implements CameraProvider {
  readonly descriptor = HANWHA_DESCRIPTOR;
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

  /** Wisenet RTSP profiles: profile2 is the main stream, profile3 the sub. */
  get #rtspProfile(): number {
    return String(this.#ctx.settings.stream ?? 'main').trim() === 'sub' ? 3 : 2;
  }

  get #channel(): number {
    const n = Number(this.#ctx.settings.channel ?? 0);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  get #rtspPort(): number {
    const n = Number(this.#ctx.settings.rtspPort ?? 554);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 554;
  }

  get #cameraId(): string {
    return `channel-${this.#channel}`;
  }

  #httpUrl(path: string): string {
    return new URL(path, this.#baseUrl.origin).toString();
  }

  async #deviceInfo(): Promise<HanwhaDeviceInfo> {
    const response = await fetchWithDigest(
      this.#ctx.fetchImpl,
      this.#httpUrl('/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view'),
      {
        username: this.#username,
        password: this.#ctx.secrets.password ?? '',
        timeoutMs: this.#ctx.timeoutMs,
      },
    );
    if (response.status === 401) throw new AppError('UPSTREAM_ERROR', 'unauthorised');
    if (!response.ok) throw new AppError('UPSTREAM_ERROR', `HTTP ${response.status}`);
    const text = await response.text();
    // SUNAPI replies with `Key=Value` lines.
    const pick = (key: string): string | null => {
      const m = new RegExp(`^${key}=(.+)$`, 'im').exec(text);
      return m?.[1]?.trim() || null;
    };
    return {
      model: pick('Model'),
      firmware: pick('FirmwareVersion'),
      name: pick('DeviceName') ?? pick('ConnectedMACAddress'),
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
      const info = await this.#deviceInfo();
      return {
        ok: true,
        message: `Reached ${info.model ?? 'the camera'}.`,
        cameraCount: 1,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreachable';
      if (message === 'unauthorised') {
        return {
          ok: false,
          message: 'The camera rejected the login. Check the username and password.',
          cameraCount: null,
          latencyMs: Date.now() - started,
        };
      }
      return {
        ok: false,
        message: 'The camera could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    let info: HanwhaDeviceInfo | null = null;
    try {
      info = await this.#deviceInfo();
    } catch {
      info = null;
    }
    return [this.#camera(info)];
  }

  async getCamera(cameraId: string): Promise<Camera> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    return (await this.listCameras())[0]!;
  }

  #camera(info: HanwhaDeviceInfo | null): Camera {
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return {
      id: this.#cameraId,
      name: configured || info?.name || 'Wisenet camera',
      location: null,
      group: null,
      model: info?.model ?? 'Wisenet',
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
        status: info ? 'online' : 'unknown',
        recording: null,
        streaming: false,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: info ? null : 'Health is checked when the connection is probed.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    const response = await fetchWithDigest(
      this.#ctx.fetchImpl,
      this.#httpUrl(
        `/stw-cgi/video.cgi?msubmenu=snapshot&action=view&Profile=1&Channel=${this.#channel}`,
      ),
      {
        username: this.#username,
        password: this.#ctx.secrets.password ?? '',
        timeoutMs: this.#ctx.timeoutMs,
      },
    );
    if (!response.ok) {
      throw new AppError('CAMERA_OFFLINE', `Could not capture a frame (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
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
    // Credentials go in the URL because RTSP has no other way to authenticate;
    // the session is minted per request, returned only to an authenticated
    // caller, and never logged.
    const url = new URL(`rtsp://${this.#baseUrl.hostname}`);
    url.port = String(this.#rtspPort);
    url.username = encodeURIComponent(this.#username);
    url.password = encodeURIComponent(password);
    url.pathname = `/profile${this.#rtspProfile}/media.smp`;

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
      'Wisenet PTZ and controls are not exposed by this connection.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Wisenet events are read through SUNAPI’s own menu.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Wisenet events are read through SUNAPI’s own menu.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Wisenet SD-card / recorder footage is reached through SUNAPI’s playback menu.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Wisenet SD-card / recorder footage is reached through SUNAPI’s playback menu.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
