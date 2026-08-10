/**
 * Scrypted source.
 *
 * Unlike every other provider here, Scrypted exposes no REST: an external client
 * talks to it only over engine.io/RPC via the official `@scrypted/client`. So
 * this provider is the one that does not take the injected `fetch` — it holds a
 * connected `ScryptedClientStatic` instead, and its runtime behaviour is proven
 * against a real Scrypted server rather than by the fetch-stub tests the others
 * use (the client is mocked in unit tests).
 *
 * Scope (v1): discovery, snapshots and health. Live view rides the gateway's
 * configured go2rtc/MediaMTX exactly as the other providers do — the Scrypted
 * cameras must be reachable there by the same id. Events, recordings and camera
 * controls are declared unsupported rather than faked; Scrypted can do all
 * three, but each is its own RPC surface and a later change.
 */
import { connectScryptedClient } from '@scrypted/client';
import type { Camera as ScryptedCameraDevice, ScryptedDevice, VideoCamera } from '@scrypted/types';
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

type ScryptedClient = Awaited<ReturnType<typeof connectScryptedClient>>;
type CameraLike = ScryptedDevice & ScryptedCameraDevice & VideoCamera;

/** Interfaces we key capabilities off, as the strings Scrypted reports them as. */
const CAMERA = 'Camera';
const VIDEO_CAMERA = 'VideoCamera';
const PAN_TILT_ZOOM = 'PanTiltZoom';
const INTERCOM = 'Intercom';

export const SCRYPTED_DESCRIPTOR: ProviderDescriptor = {
  id: 'scrypted',
  displayName: 'Scrypted',
  summary:
    'A Scrypted server. Cameras and snapshots are discovered over Scrypted’s own connection; live view plays through the gateway’s go2rtc like the other sources.',
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
      label: 'Server URL',
      type: 'url',
      required: true,
      placeholder: 'https://scrypted.local:10443',
      help: 'The Scrypted server address, including the port (usually 10443).',
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      required: true,
    },
    {
      key: 'password',
      label: 'Password or login token',
      type: 'secret',
      required: true,
      help: 'A Scrypted login token (npx scrypted login) is preferable to the account password.',
    },
  ],
};

/** The plugin scope the client connects as; core grants read of the device tree. */
const CLIENT_PLUGIN_ID = '@scrypted/core';

export class ScryptedProvider implements CameraProvider {
  readonly descriptor = SCRYPTED_DESCRIPTOR;
  readonly #ctx: ProviderContext;
  /** Memoised connection, cleared on failure so the next call reconnects. */
  #client: Promise<ScryptedClient> | null = null;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #baseUrl(): string {
    return String(this.#ctx.settings.baseUrl ?? '').replace(/\/+$/, '');
  }

  async #connect(): Promise<ScryptedClient> {
    if (!this.#baseUrl) {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'No Scrypted server URL is set.');
    }
    if (!this.#client) {
      this.#client = connectScryptedClient({
        baseUrl: this.#baseUrl,
        pluginId: CLIENT_PLUGIN_ID,
        username: String(this.#ctx.settings.username ?? ''),
        password: this.#ctx.secrets.password ?? '',
      }).catch((error: unknown) => {
        // Do not cache a rejected connection: a later attempt must be free to
        // try again rather than replay the failure forever.
        this.#client = null;
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          error instanceof Error ? error.message : 'Scrypted could not be reached.',
        );
      });
    }
    return this.#client;
  }

  /** Every camera device id known to this Scrypted server. */
  async #cameraIds(client: ScryptedClient): Promise<string[]> {
    const state = client.systemManager.getSystemState();
    return Object.keys(state).filter((id) => {
      const device = client.systemManager.getDeviceById(id) as CameraLike | undefined;
      const interfaces = device?.interfaces ?? [];
      return interfaces.includes(CAMERA) || interfaces.includes(VIDEO_CAMERA);
    });
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const client = await this.#connect();
      const count = (await this.#cameraIds(client)).length;
      return {
        ok: true,
        message: `Reached Scrypted; ${count} camera(s) available.`,
        cameraCount: count,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Scrypted could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    const client = await this.#connect();
    const ids = await this.#cameraIds(client);
    return ids.map((id) =>
      this.#toCamera(client.systemManager.getDeviceById(id) as CameraLike, id),
    );
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const client = await this.#connect();
    const device = client.systemManager.getDeviceById(cameraId) as CameraLike | undefined;
    const interfaces = device?.interfaces ?? [];
    if (!device || !(interfaces.includes(CAMERA) || interfaces.includes(VIDEO_CAMERA))) {
      throw AppError.notFound('Camera');
    }
    return this.#toCamera(device, cameraId);
  }

  #toCamera(device: CameraLike, id: string): Camera {
    const interfaces = device.interfaces ?? [];
    return {
      id,
      name: device.name ?? `Camera ${id}`,
      location: device.room ?? null,
      group: null,
      model: device.info?.model ?? null,
      firmware: device.info?.firmware ?? null,
      capabilities: {
        ptz: interfaces.includes(PAN_TILT_ZOOM),
        presets: false,
        zoom: interfaces.includes(PAN_TILT_ZOOM),
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: interfaces.includes(INTERCOM),
        // Whether a stream carries audio is not knowable without opening it.
        audio: null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: interfaces.includes(CAMERA),
        // Live view rides the gateway relay's go2rtc/MediaMTX, like every other
        // provider; HLS is what the relay serves.
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        // The device is present in Scrypted; finer per-camera reachability would
        // need the Online interface, which not every camera implements.
        status: 'online',
        recording: null,
        streaming: true,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: null,
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    const client = await this.#connect();
    const device = client.systemManager.getDeviceById(cameraId) as CameraLike | undefined;
    if (!device || typeof device.takePicture !== 'function') {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'This Scrypted device cannot take a picture.');
    }
    try {
      const picture = await device.takePicture();
      const bytes = await client.mediaManager.convertMediaObjectToBuffer(picture, 'image/jpeg');
      return { bytes, contentType: 'image/jpeg', capturedAt: new Date().toISOString() };
    } catch (error) {
      // A snapshot failure is the camera's state, not a broken connection, so it
      // is reported as offline rather than tearing the client down.
      throw new AppError(
        'CAMERA_OFFLINE',
        error instanceof Error ? error.message : 'The camera did not return a snapshot.',
      );
    }
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    // The gateway relay mints the real playback URL against its configured
    // go2rtc/MediaMTX, keyed by this camera id; the provider only carries the
    // negotiated protocol through, exactly as the go2rtc adapter does.
    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      playbackUrl: '',
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // The relay owns the playback session; there is nothing to release here.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Scrypted camera controls are not wired yet.');
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Scrypted events are not wired yet.');
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Scrypted events are not wired yet.');
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Scrypted recordings are not wired yet.');
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Scrypted recordings are not wired yet.');
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
