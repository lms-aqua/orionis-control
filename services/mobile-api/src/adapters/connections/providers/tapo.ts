/**
 * TP-Link Tapo cameras, over their local RTSP interface.
 *
 * Tapo cameras publish two local streams once a "Camera Account" is set in the
 * Tapo app — `stream1` (full resolution) and `stream2` (a lower-rate copy). That
 * account is separate from the TP-Link cloud login, and it is the only
 * credential this provider ever handles: nothing here talks to TP-Link's cloud,
 * so no account password leaves the network.
 *
 * What Tapo does *not* expose locally is everything else. Motion events, the
 * SD-card recording index and PTZ live behind a proprietary, encrypted local API
 * that changes between firmware versions; ONVIF covers some of it on some
 * models and not others. Rather than half-implement that and have features that
 * work on one camera and not the next, this provider declares live view only.
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

export const TAPO_DESCRIPTOR: ProviderDescriptor = {
  id: 'tapo',
  displayName: 'TP-Link Tapo',
  summary:
    'A Tapo camera on your own network, over local RTSP. Live view only — Tapo keeps motion events, SD-card recordings and PTZ behind a proprietary local API.',
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
      key: 'rtspUrl',
      label: 'Camera address',
      type: 'url',
      required: true,
      placeholder: 'rtsp://192.168.1.50:554',
      help: 'The camera on your network. Port 554 unless you changed it.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Driveway',
      help: 'What this camera is called in the app. Defaults to the connection name.',
    },
    {
      key: 'quality',
      label: 'Stream',
      type: 'text',
      required: false,
      default: 'stream1',
      help: 'stream1 is full resolution. stream2 is a lighter copy, better over cellular.',
    },
    {
      key: 'cameraAccount',
      label: 'Camera account username',
      type: 'text',
      required: true,
      help: 'Set under Advanced Settings → Camera Account in the Tapo app. Not your TP-Link login.',
    },
    {
      key: 'cameraSecret',
      label: 'Camera account password',
      type: 'secret',
      required: true,
      help: 'Stored encrypted. Used only to open the local stream; it never leaves your network.',
    },
  ],
};

export class TapoProvider implements CameraProvider {
  readonly descriptor = TAPO_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #address(): URL {
    const raw = String(this.#ctx.settings.rtspUrl ?? '').trim();
    if (!raw) throw new AppError('SERVICE_NOT_CONFIGURED', 'No camera address is set.');
    try {
      return new URL(raw);
    } catch {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The camera address is not a valid URL.');
    }
  }

  get #streamPath(): string {
    const raw = String(this.#ctx.settings.quality ?? 'stream1').trim();
    // Only the two paths Tapo actually serves; anything else would produce a
    // stream URL that silently fails to open.
    return raw === 'stream2' ? 'stream2' : 'stream1';
  }

  get #cameraId(): string {
    return 'camera';
  }

  get #displayName(): string {
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return configured || 'Tapo camera';
  }

  /**
   * Tapo cameras answer HTTPS on 443 with a self-signed certificate, which is
   * enough to prove the camera is powered on and on the network. It is *not*
   * proof that the camera account works — only opening the stream shows that —
   * and the probe message says so rather than implying a full check.
   */
  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    const address = this.#address;
    if (!this.#ctx.secrets.cameraSecret) {
      return {
        ok: false,
        message: 'No camera account password is set.',
        cameraCount: null,
        latencyMs: null,
      };
    }

    try {
      const response = await this.#ctx.fetchImpl(`https://${address.hostname}/`, {
        signal: AbortSignal.timeout(this.#ctx.timeoutMs),
      });
      // Any HTTP answer at all means something is listening; Tapo's web
      // endpoint returns 401/404 for an unauthenticated request.
      return {
        ok: true,
        message: `Camera answered on the network (HTTP ${response.status}). The stream itself is checked when live view opens.`,
        cameraCount: 1,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      // A self-signed certificate is the normal case for these cameras, and
      // failing to verify it says nothing about whether the camera is up.
      const message = error instanceof Error ? error.message : 'The camera did not answer.';
      const tls = /certificate|self-signed|SSL|TLS/i.test(message);
      return {
        ok: tls,
        message: tls
          ? 'Camera answered, but with its own self-signed certificate. Live view uses RTSP and is unaffected.'
          : `The camera did not answer on the network: ${message}`,
        cameraCount: tls ? 1 : null,
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
    return {
      id: this.#cameraId,
      name: this.#displayName,
      location: null,
      group: null,
      model: 'Tapo',
      firmware: null,
      capabilities: {
        // Tapo's PTZ models do move, but only through the proprietary local
        // API. Advertising controls that fail on tap is worse than saying no.
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        // Tapo streams carry audio, but whether this one does is only knowable
        // once the stream is open.
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
        // Reachability is recorded by the probe, on its own schedule. Claiming
        // "online" here would be asserting something this call never checked.
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
        message: 'Tapo cameras report nothing until a stream is opened.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Tapo cameras do not serve stills locally. A snapshot would mean opening the video stream.',
    );
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    if (input.cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    const account = String(this.#ctx.settings.cameraAccount ?? '').trim();
    const secret = this.#ctx.secrets.cameraSecret ?? '';
    if (!account || !secret) {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The camera account is incomplete.');
    }

    const address = this.#address;
    // Credentials go in the URL because that is the only way to authenticate
    // RTSP here. The session is minted per request and returned exclusively to
    // an authenticated caller, and it is never logged — the redactor drops
    // playback URLs alongside tokens.
    const url = new URL(address.toString());
    url.username = encodeURIComponent(account);
    url.password = encodeURIComponent(secret);
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
      'Tapo keeps camera controls behind its own local API, which this connection does not speak.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Tapo does not publish motion events locally.');
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Tapo does not publish motion events locally.');
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Tapo SD-card recordings are only reachable through the Tapo app.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Tapo SD-card recordings are only reachable through the Tapo app.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
