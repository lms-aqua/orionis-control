/**
 * Dahua cameras — and the many brands built on Dahua's platform, Amcrest being
 * the common one — over their local CGI API and RTSP.
 *
 * Dahua's HTTP API answers `magicBox.cgi?action=getDeviceType` (a model string)
 * and `snapshot.cgi` (a JPEG still), and it defaults to Digest authentication,
 * which is why this provider shares the Digest helper with Hikvision rather
 * than putting credentials on the wire in the clear. Live video is RTSP. All of
 * it is local: nothing here talks to a Dahua or Amcrest cloud.
 *
 * Motion events and the SD-card recording index live behind Dahua's own
 * event-stream and media-file APIs, which differ enough across firmware that
 * advertising them would mean features that work on one camera and not the
 * next. This provider declares snapshots and live view.
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

export const DAHUA_DESCRIPTOR: ProviderDescriptor = {
  id: 'dahua',
  displayName: 'Dahua / Amcrest',
  summary:
    'A Dahua or Amcrest camera on your own network, over its local CGI API and RTSP. Snapshots and live view — motion events and recordings stay behind the camera’s own APIs.',
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
      placeholder: 'http://192.168.1.70',
      help: 'The camera on your network. Use http:// unless you have enabled HTTPS on it.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Back Yard',
      help: 'What this camera is called in the app. Defaults to the connection name.',
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
      default: 1,
      advanced: true,
      help: 'For a recorder, which channel to use (1 is the first). A standalone camera is 1.',
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

export class DahuaProvider implements CameraProvider {
  readonly descriptor = DAHUA_DESCRIPTOR;
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

  /** Dahua channels are 1-based, both in the CGI API and the RTSP path. */
  get #channel(): number {
    const n = Number(this.#ctx.settings.channel ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  /** RTSP subtype: 0 is the main stream, 1 the substream. */
  get #subtype(): number {
    return String(this.#ctx.settings.stream ?? 'main').trim() === 'sub' ? 1 : 0;
  }

  get #rtspPort(): number {
    const n = Number(this.#ctx.settings.rtspPort ?? 554);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 554;
  }

  get #cameraId(): string {
    return `channel-${this.#channel}`;
  }

  /**
   * Resolves a path (which may carry a query string) against the camera's
   * origin. Assigning to `url.pathname` would percent-encode the `?`, so the
   * relative-URL constructor is used instead.
   */
  #httpUrl(path: string): string {
    return new URL(path, this.#baseUrl.origin).toString();
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
      const response = await fetchWithDigest(
        this.#ctx.fetchImpl,
        this.#httpUrl('/cgi-bin/magicBox.cgi?action=getDeviceType'),
        {
          username: this.#username,
          password: this.#ctx.secrets.password,
          timeoutMs: this.#ctx.timeoutMs,
        },
      );
      if (response.status === 401) {
        return {
          ok: false,
          message: 'The camera rejected the login. Check the username and password.',
          cameraCount: null,
          latencyMs: Date.now() - started,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          message: `The camera answered with HTTP ${response.status}.`,
          cameraCount: null,
          latencyMs: Date.now() - started,
        };
      }
      const text = (await response.text()).trim();
      const model = /type=(.+)/i.exec(text)?.[1]?.trim() ?? 'camera';
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

  async #deviceType(): Promise<string | null> {
    try {
      const response = await fetchWithDigest(
        this.#ctx.fetchImpl,
        this.#httpUrl('/cgi-bin/magicBox.cgi?action=getDeviceType'),
        {
          username: this.#username,
          password: this.#ctx.secrets.password ?? '',
          timeoutMs: this.#ctx.timeoutMs,
        },
      );
      if (!response.ok) return null;
      const text = (await response.text()).trim();
      return /type=(.+)/i.exec(text)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }

  async listCameras(): Promise<Camera[]> {
    const model = await this.#deviceType();
    return [this.#camera(model)];
  }

  async getCamera(cameraId: string): Promise<Camera> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    return (await this.listCameras())[0]!;
  }

  #camera(model: string | null): Camera {
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return {
      id: this.#cameraId,
      name: configured || 'Dahua camera',
      location: null,
      group: null,
      model: model ?? 'Dahua',
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
        snapshot: true,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        status: model ? 'online' : 'unknown',
        recording: null,
        streaming: false,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: model ? null : 'Health is checked when the connection is probed.',
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
      this.#httpUrl(`/cgi-bin/snapshot.cgi?channel=${this.#channel}`),
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
    // Dahua's RTSP path takes channel and subtype as query parameters.
    // Credentials go in the URL because RTSP has no other way to authenticate;
    // the session is minted per request, returned only to an authenticated
    // caller, and never logged.
    const url = new URL(`rtsp://${this.#baseUrl.hostname}`);
    url.port = String(this.#rtspPort);
    url.username = encodeURIComponent(this.#username);
    url.password = encodeURIComponent(password);
    url.pathname = '/cam/realmonitor';
    url.searchParams.set('channel', String(this.#channel));
    url.searchParams.set('subtype', String(this.#subtype));

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
      'Dahua PTZ commands vary by model and are not exposed by this connection.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Dahua motion events are read through the camera’s own event stream.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Dahua motion events are read through the camera’s own event stream.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Dahua SD-card and recorder footage is reached through the camera’s own media API.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Dahua SD-card and recorder footage is reached through the camera’s own media API.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
