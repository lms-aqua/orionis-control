/**
 * VIVOTEK cameras, over their local HTTP interface and RTSP.
 *
 * VIVOTEK's local API answers `getparam.cgi` (from which the model name is
 * read) and serves a JPEG still at `/cgi-bin/viewer/video.jpg`, both behind
 * Digest authentication — so this provider shares the Digest helper with the
 * other on-network sources. Live video is RTSP at VIVOTEK's `live.sdp` paths.
 * Nothing here contacts a VIVOTEK cloud.
 *
 * VIVOTEK's event and edge-recording features are configured through further
 * CGI whose parameters vary across firmware and model lines; this provider
 * declares the snapshots and live view every VIVOTEK does the same way.
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

export const VIVOTEK_DESCRIPTOR: ProviderDescriptor = {
  id: 'vivotek',
  displayName: 'VIVOTEK',
  summary:
    'A VIVOTEK camera on your own network, over its local interface and RTSP. Snapshots and live view — events and recordings stay behind the camera’s own CGI.',
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
      placeholder: 'http://192.168.1.110',
      help: 'The camera on your network. Use http:// unless you have enabled HTTPS on it.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Warehouse',
      help: 'What this camera is called in the app. Defaults to the model the camera reports.',
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      required: true,
      placeholder: 'viewer',
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
      key: 'streamIndex',
      label: 'Stream',
      type: 'number',
      required: false,
      default: 1,
      advanced: true,
      help: 'Which stream profile to use (1 is the primary). Higher numbers are usually lighter copies.',
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

export class VivotekProvider implements CameraProvider {
  readonly descriptor = VIVOTEK_DESCRIPTOR;
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

  /** VIVOTEK stream profiles are 1-based; the RTSP path for profile 1 is
   * `live.sdp`, and profile N (>1) is `liveN.sdp`. */
  get #streamIndex(): number {
    const n = Number(this.#ctx.settings.streamIndex ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  get #rtspPath(): string {
    return this.#streamIndex <= 1 ? '/live.sdp' : `/live${this.#streamIndex}.sdp`;
  }

  get #rtspPort(): number {
    const n = Number(this.#ctx.settings.rtspPort ?? 554);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 554;
  }

  get #cameraId(): string {
    return 'camera';
  }

  #httpUrl(path: string): string {
    return new URL(path, this.#baseUrl.origin).toString();
  }

  async #modelName(): Promise<string | null> {
    const response = await fetchWithDigest(
      this.#ctx.fetchImpl,
      this.#httpUrl('/cgi-bin/viewer/getparam.cgi?system_info_modelname'),
      {
        username: this.#username,
        password: this.#ctx.secrets.password ?? '',
        timeoutMs: this.#ctx.timeoutMs,
      },
    );
    if (response.status === 401) throw new AppError('UPSTREAM_ERROR', 'unauthorised');
    if (!response.ok) throw new AppError('UPSTREAM_ERROR', `HTTP ${response.status}`);
    const text = await response.text();
    // Response is `system_info_modelname='IB9389-EH'`.
    return /modelname='?([^'\r\n]+)'?/i.exec(text)?.[1]?.trim() || null;
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
      const model = await this.#modelName();
      return {
        ok: true,
        message: `Reached ${model ?? 'the camera'}.`,
        cameraCount: 1,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof AppError && error.message === 'unauthorised') {
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
    let model: string | null = null;
    try {
      model = await this.#modelName();
    } catch {
      model = null;
    }
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
      name: configured || model || 'VIVOTEK camera',
      location: null,
      group: null,
      model: model ?? 'VIVOTEK',
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
      this.#httpUrl('/cgi-bin/viewer/video.jpg'),
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
    url.pathname = this.#rtspPath;

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
      'VIVOTEK PTZ commands are not exposed by this connection.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'VIVOTEK events are read through its own CGI.');
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'VIVOTEK events are read through its own CGI.');
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'VIVOTEK edge recordings are reached through the camera’s own CGI.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'VIVOTEK edge recordings are reached through the camera’s own CGI.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
