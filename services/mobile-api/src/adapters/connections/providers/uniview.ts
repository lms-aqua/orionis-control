/**
 * Uniview (UNV) cameras, over their local interface and RTSP.
 *
 * Uniview cameras serve a JPEG still over HTTP and publish RTSP locally, both
 * behind Digest authentication, so this provider shares the Digest helper with
 * the other on-network sources. Nothing here contacts a Uniview cloud.
 *
 * The RTSP path is stable across the range (`/media/video1` main, `/media/video2`
 * sub); the snapshot path varies a little by model and firmware, so it defaults
 * to the common `/images/snapshot.jpg` and can be overridden. Uniview is also
 * fully ONVIF-compliant, so the generic ONVIF source is a fallback if a given
 * model's HTTP snapshot path differs.
 *
 * Events and recordings live behind Uniview's LAPI, which varies enough across
 * firmware that this provider declares the snapshots and live view every UNV
 * camera does the same way.
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

export const UNIVIEW_DESCRIPTOR: ProviderDescriptor = {
  id: 'uniview',
  displayName: 'Uniview (UNV)',
  summary:
    'A Uniview camera on your own network, over its local interface and RTSP. Snapshots and live view — events and recordings stay behind the camera’s own API.',
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
      placeholder: 'http://192.168.1.120',
      help: 'The camera on your network. Some Uniview models serve HTTP on port 85 — include it if so.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Loading Bay',
      help: 'What this camera is called in the app. Defaults to the connection name.',
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
      help: 'main is full resolution (video1). sub is a lighter copy (video2), better over cellular.',
    },
    {
      key: 'snapshotPath',
      label: 'Snapshot path',
      type: 'text',
      required: false,
      default: '/images/snapshot.jpg',
      advanced: true,
      help: 'The still-image path. The default suits most models; change it only if snapshots fail.',
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

export class UniviewProvider implements CameraProvider {
  readonly descriptor = UNIVIEW_DESCRIPTOR;
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

  get #streamPath(): 'video1' | 'video2' {
    return String(this.#ctx.settings.stream ?? 'main').trim() === 'sub' ? 'video2' : 'video1';
  }

  get #snapshotPath(): string {
    const raw = String(this.#ctx.settings.snapshotPath ?? '/images/snapshot.jpg').trim();
    return raw.startsWith('/') ? raw : `/${raw}`;
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

  async #snapshot(): Promise<Response> {
    return fetchWithDigest(this.#ctx.fetchImpl, this.#httpUrl(this.#snapshotPath), {
      username: this.#username,
      password: this.#ctx.secrets.password ?? '',
      timeoutMs: this.#ctx.timeoutMs,
    });
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
      const response = await this.#snapshot();
      if (response.status === 401) {
        return {
          ok: false,
          message: 'The camera rejected the login. Check the username and password.',
          cameraCount: null,
          latencyMs: Date.now() - started,
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      await response.body?.cancel().catch(() => undefined);
      if (response.ok && contentType.startsWith('image/')) {
        return {
          ok: true,
          message: 'Reached the camera.',
          cameraCount: 1,
          latencyMs: Date.now() - started,
        };
      }
      // Reachable but the snapshot path did not return an image on this model;
      // live view is RTSP and unaffected, so this is a soft success.
      return {
        ok: true,
        message:
          'Reached the camera, but its snapshot path differs on this model. Live view uses RTSP and is unaffected; set a snapshot path under advanced settings if you want stills.',
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
    return [this.#camera()];
  }

  async getCamera(cameraId: string): Promise<Camera> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    return this.#camera();
  }

  #camera(): Camera {
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return {
      id: this.#cameraId,
      name: configured || 'Uniview camera',
      location: null,
      group: null,
      model: 'Uniview',
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
        // Reachability is the probe's job; asserting "online" here would claim
        // something this call never checked.
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
        message: 'Health is checked when the connection is probed.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    const response = await this.#snapshot();
    if (!response.ok) {
      throw new AppError('CAMERA_OFFLINE', `Could not capture a frame (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      throw new AppError(
        'CAMERA_OFFLINE',
        'The camera did not return an image at the configured snapshot path. Set the correct path under advanced settings.',
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
    url.pathname = `/media/${this.#streamPath}`;

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
      'Uniview PTZ and controls are not exposed by this connection.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Uniview events are read through the camera’s own LAPI.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Uniview events are read through the camera’s own LAPI.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Uniview recordings are reached through the camera’s own LAPI.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Uniview recordings are reached through the camera’s own LAPI.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
