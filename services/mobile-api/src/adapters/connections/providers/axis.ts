/**
 * Axis cameras, over their local VAPIX interface and RTSP.
 *
 * Axis is the professional end of the market, and its VAPIX API is stable
 * across a very wide range of hardware: `param.cgi` reports the model, the
 * `jpg/image.cgi` CGI returns a JPEG still, and video is RTSP at the
 * long-standing `/axis-media/media.amp` path. All of it is local and behind
 * Digest authentication, so this provider shares the Digest helper with the
 * other on-network sources and never contacts an Axis cloud.
 *
 * Axis exposes events and edge recordings too, but through APIs (the event
 * stream, the edge-storage recording list) whose shape and availability depend
 * on firmware and installed ACAPs. This provider declares the two things every
 * Axis does identically — snapshots and live view — and says so for the rest.
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

export const AXIS_DESCRIPTOR: ProviderDescriptor = {
  id: 'axis',
  displayName: 'Axis',
  summary:
    'An Axis camera on your own network, over its local VAPIX interface and RTSP. Snapshots and live view — events and edge recordings stay behind the camera’s own APIs.',
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
      placeholder: 'http://192.168.1.100',
      help: 'The camera on your network. Use http:// unless you have enabled HTTPS on it.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Loading Dock',
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
      key: 'camera',
      label: 'Sensor',
      type: 'number',
      required: false,
      default: 1,
      advanced: true,
      help: 'For a multi-sensor camera, which sensor to use (1 is the first). A single-lens camera is 1.',
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

export class AxisProvider implements CameraProvider {
  readonly descriptor = AXIS_DESCRIPTOR;
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

  get #camera_(): number {
    const n = Number(this.#ctx.settings.camera ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  get #rtspPort(): number {
    const n = Number(this.#ctx.settings.rtspPort ?? 554);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 554;
  }

  get #cameraId(): string {
    return `sensor-${this.#camera_}`;
  }

  #httpUrl(path: string): string {
    return new URL(path, this.#baseUrl.origin).toString();
  }

  /** Reads a single VAPIX Brand parameter, e.g. the product full name. */
  async #brand(): Promise<string | null> {
    try {
      const response = await fetchWithDigest(
        this.#ctx.fetchImpl,
        this.#httpUrl('/axis-cgi/param.cgi?action=list&group=Brand.ProdFullName'),
        {
          username: this.#username,
          password: this.#ctx.secrets.password ?? '',
          timeoutMs: this.#ctx.timeoutMs,
        },
      );
      if (response.status === 401) throw new AppError('UPSTREAM_ERROR', 'unauthorised');
      if (!response.ok) return null;
      const text = await response.text();
      // param.cgi returns `root.Brand.ProdFullName=AXIS M3057`.
      return /ProdFullName=(.+)/i.exec(text)?.[1]?.trim() || null;
    } catch (error) {
      if (error instanceof AppError && error.message === 'unauthorised') throw error;
      return null;
    }
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
      const brand = await this.#brand();
      return {
        ok: true,
        message: `Reached ${brand ?? 'the camera'}.`,
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
    let brand: string | null = null;
    try {
      brand = await this.#brand();
    } catch {
      brand = null;
    }
    return [this.#camera(brand)];
  }

  async getCamera(cameraId: string): Promise<Camera> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    return (await this.listCameras())[0]!;
  }

  #camera(brand: string | null): Camera {
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return {
      id: this.#cameraId,
      name: configured || brand || 'Axis camera',
      location: null,
      group: null,
      model: brand ?? 'Axis',
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
        status: brand ? 'online' : 'unknown',
        recording: null,
        streaming: false,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: brand ? null : 'Health is checked when the connection is probed.',
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
      this.#httpUrl(`/axis-cgi/jpg/image.cgi?camera=${this.#camera_}`),
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
        'The camera did not return an image. Check the login and sensor number.',
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
    url.pathname = '/axis-media/media.amp';
    url.searchParams.set('camera', String(this.#camera_));

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
      'Axis PTZ and I/O controls are not exposed by this connection.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Axis events are read through the camera’s own event stream.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Axis events are read through the camera’s own event stream.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Axis edge recordings are reached through the camera’s own storage API.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Axis edge recordings are reached through the camera’s own storage API.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
