/**
 * Hikvision cameras and NVRs — and the brands built on Hikvision's platform,
 * such as Annke and some LaView — over their local ISAPI interface and RTSP.
 *
 * ISAPI answers `GET /ISAPI/System/deviceInfo` (model, firmware, name) and
 * serves a JPEG still at `/ISAPI/Streaming/channels/{id}/picture`, both behind
 * Digest authentication, which is why this provider shares the Digest helper
 * with Dahua. Live video is RTSP. Everything stays on the local network — this
 * provider never contacts Hik-Connect or any Hikvision cloud.
 *
 * Hikvision does publish a rich event and recording API, but its shape differs
 * between the camera-direct and NVR-fronted cases and across firmware
 * generations. Rather than expose a Recordings tab that works on one deployment
 * and 404s on the next, this provider declares snapshots and live view.
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

interface HikDeviceInfo {
  model: string | null;
  firmware: string | null;
  name: string | null;
}

export const HIKVISION_DESCRIPTOR: ProviderDescriptor = {
  id: 'hikvision',
  displayName: 'Hikvision',
  summary:
    'A Hikvision camera or NVR on your own network, over its local ISAPI interface and RTSP. Snapshots and live view — events and recordings stay behind the device’s own API.',
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
      label: 'Device address',
      type: 'url',
      required: true,
      placeholder: 'http://192.168.1.80',
      help: 'The camera or NVR on your network. Use http:// unless you have enabled HTTPS on it.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Front Gate',
      help: 'What this camera is called in the app. Defaults to the name the device reports.',
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      required: true,
      placeholder: 'admin',
      help: 'A device login. A dedicated viewer-only account is safer than the admin one.',
    },
    {
      key: 'password',
      label: 'Password',
      type: 'secret',
      required: true,
      help: 'Stored encrypted. Used only to reach the device on your network.',
    },
    {
      key: 'channel',
      label: 'Channel',
      type: 'number',
      required: false,
      default: 1,
      advanced: true,
      help: 'For an NVR, which camera channel to use (1 is the first). A standalone camera is 1.',
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
      help: 'Only change this if you have moved the device off the standard RTSP port.',
    },
  ],
};

export class HikvisionProvider implements CameraProvider {
  readonly descriptor = HIKVISION_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #baseUrl(): URL {
    const raw = String(this.#ctx.settings.baseUrl ?? '').trim();
    if (!raw) throw new AppError('SERVICE_NOT_CONFIGURED', 'No device address is set.');
    try {
      return new URL(raw);
    } catch {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The device address is not a valid URL.');
    }
  }

  get #username(): string {
    return String(this.#ctx.settings.username ?? '').trim();
  }

  get #channel(): number {
    const n = Number(this.#ctx.settings.channel ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  /** Hikvision stream ids: 01 is the main stream of a channel, 02 the sub. */
  get #streamSuffix(): '01' | '02' {
    return String(this.#ctx.settings.stream ?? 'main').trim() === 'sub' ? '02' : '01';
  }

  /** The ISAPI/RTSP channel id, e.g. channel 1 main is `101`. */
  get #channelId(): string {
    return `${this.#channel}${this.#streamSuffix}`;
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

  async #deviceInfo(): Promise<HikDeviceInfo> {
    const response = await fetchWithDigest(
      this.#ctx.fetchImpl,
      this.#httpUrl('/ISAPI/System/deviceInfo'),
      {
        username: this.#username,
        password: this.#ctx.secrets.password ?? '',
        timeoutMs: this.#ctx.timeoutMs,
      },
    );
    if (response.status === 401) throw new AppError('UPSTREAM_ERROR', 'unauthorised');
    if (!response.ok) throw new AppError('UPSTREAM_ERROR', `HTTP ${response.status}`);
    const xml = await response.text();
    const pick = (tag: string): string | null => {
      const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
      return m?.[1]?.trim() || null;
    };
    return {
      model: pick('model'),
      firmware: pick('firmwareVersion'),
      name: pick('deviceName'),
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
        message: `Reached ${info?.model ?? 'the device'}.`,
        cameraCount: 1,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreachable';
      if (message === 'unauthorised') {
        return {
          ok: false,
          message: 'The device rejected the login. Check the username and password.',
          cameraCount: null,
          latencyMs: Date.now() - started,
        };
      }
      return {
        ok: false,
        message: 'The device could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    let info: HikDeviceInfo | null = null;
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

  #camera(info: HikDeviceInfo | null): Camera {
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return {
      id: this.#cameraId,
      name: configured || info?.name || 'Hikvision camera',
      location: null,
      group: null,
      model: info?.model ?? 'Hikvision',
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
      this.#httpUrl(`/ISAPI/Streaming/channels/${this.#channelId}/picture`),
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
        'The device did not return an image. Check the login and channel.',
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
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The device login is incomplete.');
    }
    // Credentials go in the URL because RTSP has no other way to authenticate;
    // the session is minted per request, returned only to an authenticated
    // caller, and never logged.
    const url = new URL(`rtsp://${this.#baseUrl.hostname}`);
    url.port = String(this.#rtspPort);
    url.username = encodeURIComponent(this.#username);
    url.password = encodeURIComponent(password);
    url.pathname = `/Streaming/Channels/${this.#channelId}`;

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
    // The session is a URL; the device holds no handle to release.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Hikvision PTZ commands are not exposed by this connection.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Hikvision events are read through the device’s own alert stream.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Hikvision events are read through the device’s own alert stream.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Hikvision recordings are reached through the device’s own playback API.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Hikvision recordings are reached through the device’s own playback API.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
