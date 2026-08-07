/**
 * Google Nest cameras, through the Smart Device Management API.
 *
 * This is the only route Google supports, and it is deliberately narrow. Worth
 * knowing before configuring one, which is why the descriptor says so up front:
 *
 *   - Setting it up needs a Device Access project (a one-off fee to Google) and
 *     an OAuth client. There is no local API and no way around that.
 *   - **Newer cameras only speak WebRTC**, and their offer/answer exchange is
 *     not something this gateway proxies yet. Those cameras appear, and say
 *     plainly that live view is unavailable, instead of handing back a stream
 *     URL that cannot open.
 *   - **Events arrive by Pub/Sub**, not by polling, so there is no history to
 *     page through here.
 *
 * The refresh token is the sensitive value: it is long-lived and grants access
 * to the account's devices, so it is stored encrypted and exchanged for a
 * short-lived access token held only in memory.
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

const SDM_BASE = 'https://smartdevicemanagement.googleapis.com/v1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** Refresh a minute early; an expired token mid-request reads as an outage. */
const TOKEN_SKEW_MS = 60_000;

export const NEST_DESCRIPTOR: ProviderDescriptor = {
  id: 'nest',
  displayName: 'Google Nest',
  summary:
    'Nest cameras and doorbells through Google’s Device Access API. Live view on RTSP-capable models. Needs a Device Access project; Google charges a one-off fee for one.',
  capabilities: {
    // Nest stills come attached to Pub/Sub events, not on demand.
    snapshots: false,
    liveStream: true,
    events: false,
    // The cameras do detect people, packages and motion — but the results are
    // pushed to Pub/Sub, so this connection never sees them.
    eventDetection: false,
    recordings: false,
    controls: false,
    storageReporting: false,
    interactiveAuth: false,
  },
  fields: [
    {
      key: 'projectId',
      label: 'Device Access project ID',
      type: 'text',
      required: true,
      help: 'From console.nest.google.com/device-access. Not your Google Cloud project number.',
    },
    {
      key: 'clientId',
      label: 'OAuth client ID',
      type: 'text',
      required: true,
      help: 'The OAuth client you created in Google Cloud for Device Access.',
    },
    {
      key: 'clientSecret',
      label: 'OAuth client secret',
      type: 'secret',
      required: true,
      help: 'Stored encrypted.',
    },
    {
      key: 'refreshToken',
      label: 'OAuth refresh token',
      type: 'secret',
      required: true,
      help: 'From the one-time authorisation flow. Stored encrypted and exchanged for short-lived tokens.',
    },
  ],
};

interface SdmTrait {
  customName?: string;
  supportedProtocols?: string[];
  maxVideoResolution?: { width?: number; height?: number };
  [key: string]: unknown;
}

interface SdmDevice {
  name: string;
  type?: string;
  traits?: Record<string, SdmTrait>;
  parentRelations?: { parent?: string; displayName?: string }[];
}

interface SdmRtspResult {
  results?: {
    streamUrls?: { rtspUrl?: string };
    expiresAt?: string;
    streamExtensionToken?: string;
    streamToken?: string;
  };
}

export class NestProvider implements CameraProvider {
  readonly descriptor = NEST_DESCRIPTOR;
  readonly #ctx: ProviderContext;
  /** Held in memory only; never persisted, never logged. */
  #accessToken: { value: string; expiresAt: number } | null = null;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #projectId(): string {
    const raw = String(this.#ctx.settings.projectId ?? '').trim();
    if (!raw) throw new AppError('SERVICE_NOT_CONFIGURED', 'No Device Access project ID is set.');
    return raw;
  }

  /**
   * A valid access token, refreshed on demand.
   *
   * Google's tokens last an hour; caching one avoids a token round trip on
   * every camera-wall refresh, and the skew keeps a request from starting with
   * a token that expires mid-flight.
   */
  async #token(): Promise<string> {
    const cached = this.#accessToken;
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.value;

    const clientId = String(this.#ctx.settings.clientId ?? '').trim();
    const clientSecret = this.#ctx.secrets.clientSecret ?? '';
    const refreshToken = this.#ctx.secrets.refreshToken ?? '';
    if (!clientId || !clientSecret || !refreshToken) {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The Google credentials are incomplete.');
    }

    const response = await this.#ctx.fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      // A revoked or expired refresh token is the common case, and it needs the
      // authorisation flow run again — say that rather than "unauthorized".
      throw new AppError(
        'UPSTREAM_ERROR',
        body.error === 'invalid_grant'
          ? 'Google rejected the refresh token. It was revoked or expired — run the authorisation flow again and paste the new token.'
          : (body.error_description ?? 'Google would not issue an access token.'),
      );
    }

    this.#accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  async #get<T>(path: string): Promise<T> {
    const response = await this.#ctx.fetchImpl(`${SDM_BASE}${path}`, {
      headers: { authorization: `Bearer ${await this.#token()}`, accept: 'application/json' },
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) throw await this.#error(response);
    return (await response.json()) as T;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#ctx.fetchImpl(`${SDM_BASE}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) throw await this.#error(response);
    return (await response.json()) as T;
  }

  async #error(response: Response): Promise<AppError> {
    if (response.status === 404) return AppError.notFound('Nest device');
    if (response.status === 403) {
      return new AppError(
        'UPSTREAM_ERROR',
        'Google refused the request. Check that the Device Access project is linked to this account and the camera is shared with it.',
      );
    }
    if (response.status === 429) {
      return new AppError('UPSTREAM_ERROR', 'Google is rate-limiting this project. Try again shortly.');
    }
    return new AppError('UPSTREAM_ERROR', `Google returned HTTP ${response.status}.`);
  }

  /** `enterprises/x/devices/y` → `y`, since the prefix is fixed per project. */
  #deviceId(name: string): string {
    const parts = name.split('/');
    return parts[parts.length - 1] ?? name;
  }

  async #devices(): Promise<SdmDevice[]> {
    const body = await this.#get<{ devices?: SdmDevice[] }>(
      `/enterprises/${encodeURIComponent(this.#projectId)}/devices`,
    );
    // Thermostats and other Nest devices come back on the same endpoint.
    return (body.devices ?? []).filter((d) => /CAMERA|DOORBELL|DISPLAY/i.test(d.type ?? ''));
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const devices = await this.#devices();
      return {
        ok: true,
        message:
          devices.length === 0
            ? 'Connected to Google, but this project has no cameras shared with it yet.'
            : `Connected to Google; ${devices.length} camera(s) available.`,
        cameraCount: devices.length,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Google could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    return (await this.#devices()).map((d) => this.#camera(d));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const device = (await this.#devices()).find((d) => this.#deviceId(d.name) === cameraId);
    if (!device) throw AppError.notFound('Camera');
    return this.#camera(device);
  }

  /** Whether this model can hand back an RTSP URL at all. */
  #supportsRtsp(device: SdmDevice): boolean {
    const trait = device.traits?.['sdm.devices.traits.CameraLiveStream'];
    return (trait?.supportedProtocols ?? []).includes('RTSP');
  }

  #camera(device: SdmDevice): Camera {
    const id = this.#deviceId(device.name);
    const info = device.traits?.['sdm.devices.traits.Info'];
    const room = device.parentRelations?.[0]?.displayName ?? null;
    const live = device.traits?.['sdm.devices.traits.CameraLiveStream'];
    const resolution = live?.maxVideoResolution;
    const rtsp = this.#supportsRtsp(device);

    return {
      id,
      name: info?.customName || room || 'Nest camera',
      location: room,
      group: null,
      model: (device.type ?? '').split('.').pop() ?? null,
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
        snapshot: false,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        // Google's device list says a camera exists and is shared, not whether
        // it is online this second. Claiming "online" would be inventing it.
        status: 'unknown',
        recording: null,
        streaming: false,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution:
          resolution?.width && resolution?.height
            ? `${resolution.width}x${resolution.height}`
            : null,
        message: rtsp
          ? null
          : 'This model streams over WebRTC only, which this connection cannot open yet.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Nest only produces stills attached to its own event notifications, which this connection does not receive.',
    );
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    const device = (await this.#devices()).find((d) => this.#deviceId(d.name) === input.cameraId);
    if (!device) throw AppError.notFound('Camera');
    if (!this.#supportsRtsp(device)) {
      throw new AppError(
        'STREAM_UNAVAILABLE',
        'This Nest model streams over WebRTC only. Opening it needs an offer/answer exchange this gateway does not proxy yet.',
      );
    }

    const result = await this.#post<SdmRtspResult>(`/${device.name}:executeCommand`, {
      command: 'sdm.devices.commands.CameraLiveStream.GenerateRtspStream',
      params: {},
    });
    const url = result.results?.streamUrls?.rtspUrl;
    if (!url) {
      throw new AppError('STREAM_UNAVAILABLE', 'Google did not return a stream for this camera.');
    }

    // Google's stream expires on its own schedule — around five minutes — and
    // promising longer than it granted would leave the player dead mid-view
    // with no explanation.
    const granted = result.results?.expiresAt ? Date.parse(result.results.expiresAt) : NaN;
    const requested = Date.now() + input.ttlSeconds * 1000;
    const expiresAt = Number.isFinite(granted) ? Math.min(granted, requested) : requested;

    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      playbackUrl: url,
      expiresAt: new Date(expiresAt).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // Google expires the stream itself; there is no revoke command, and the
    // extension token is only useful for prolonging one.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Nest cameras expose no controls through this API.');
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Nest pushes its detections to Google Pub/Sub rather than offering a history to read.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Nest pushes its detections to Google Pub/Sub rather than offering a history to read.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Nest Aware recordings are only available in the Google Home app.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Nest Aware recordings are only available in the Google Home app.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
