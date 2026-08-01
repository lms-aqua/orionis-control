/**
 * Orionis adapter backed by a go2rtc server.
 *
 * go2rtc (https://github.com/AlexxIT/go2rtc) exposes a small JSON API that lists
 * streams and serves single JPEG frames. That is enough to drive the app's
 * camera list and live snapshots. It has no notion of events, recordings, PTZ,
 * or an authenticated media edge, so those operations honestly report
 * CAPABILITY_UNSUPPORTED (or empty pages) rather than inventing data.
 */
import { AppError } from '../../lib/errors.ts';
import { UpstreamClient } from '../../lib/http-upstream.ts';
import type {
  Camera,
  CameraControlRequest,
  CameraControlResult,
  CameraEvent,
  EventQuery,
  OrionisAdapter,
  OrionisServiceHealth,
  Page,
  Recording,
  RecordingQuery,
  StorageStatus,
  StreamProtocol,
  StreamQuality,
  StreamSession,
} from './types.ts';

interface Go2rtcStream {
  producers?: { url?: string }[] | null;
  consumers?: unknown[] | null;
}

const CAPABILITIES = {
  ptz: false,
  presets: false,
  zoom: false,
  light: false,
  siren: false,
  privacyMode: false,
  twoWayAudio: false,
  audio: true,
  recordingToggle: false,
  motionToggle: false,
  sensitivity: false,
  restart: false,
  snapshot: true,
  // The gateway relays go2rtc HLS (AVPlayer-native); WebRTC/MJPEG are not
  // exposed, so only HLS is advertised for negotiation.
  protocols: ['hls'] as StreamProtocol[],
  qualities: ['auto'] as StreamQuality[],
};

export class Go2rtcOrionisAdapter implements OrionisAdapter {
  readonly kind = 'http' as const;
  readonly configured = true;
  private readonly client: UpstreamClient;
  private readonly labels: Record<string, { name: string; location: string | null }>;

  constructor(
    baseUrl: string,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
    labels: Record<string, { name: string; location: string | null }> = {},
  ) {
    this.client = new UpstreamClient(
      'go2rtc',
      baseUrl,
      { accept: 'application/json' },
      timeoutMs,
      fetchImpl,
    );
    this.labels = labels;
  }

  private async streams(): Promise<Record<string, Go2rtcStream>> {
    const { data } = await this.client.request<Record<string, Go2rtcStream>>({
      path: '/api/streams',
    });
    return data ?? {};
  }

  private toCamera(id: string, stream: Go2rtcStream | undefined): Camera {
    const online = Boolean(stream?.producers && stream.producers.length > 0);
    // go2rtc names its streams after the upstream device id. A configured label
    // turns that into something recognisable; without one, the id is shown
    // as-is rather than guessed at.
    const label = this.labels[id];
    return {
      id,
      name: label?.name ?? `Camera ${id}`,
      location: label?.location ?? null,
      group: null,
      model: 'go2rtc',
      firmware: null,
      capabilities: { ...CAPABILITIES },
      health: {
        status: online ? 'online' : 'offline',
        recording: false,
        streaming: online,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: online ? new Date().toISOString() : null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: online ? null : 'No producer is currently connected for this stream.',
      },
      snapshotPath: `/cameras/${encodeURIComponent(id)}/snapshot`,
    };
  }

  async listCameras(): Promise<Camera[]> {
    const streams = await this.streams();
    return Object.keys(streams)
      .sort()
      .map((id) => this.toCamera(id, streams[id]));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const streams = await this.streams();
    if (!(cameraId in streams)) {
      throw new AppError('NOT_FOUND', `No camera named "${cameraId}" is known to go2rtc.`);
    }
    return this.toCamera(cameraId, streams[cameraId]);
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    const streams = await this.streams();
    if (!(cameraId in streams)) {
      throw new AppError('NOT_FOUND', `No camera named "${cameraId}" is known to go2rtc.`);
    }
    const { data } = await this.client.request<Buffer>({
      path: '/api/frame.jpeg',
      query: { src: cameraId },
      binary: true,
      headers: { accept: 'image/jpeg' },
    });
    if (!data || data.length === 0) {
      throw new AppError('CAMERA_OFFLINE', 'The camera did not return a snapshot.');
    }
    return { bytes: data, contentType: 'image/jpeg', capturedAt: new Date().toISOString() };
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    // The go2rtc HLS data plane is proxied by the gateway's /stream/:id relay,
    // which builds the real token-bound playbackUrl. This returns the
    // negotiated shape (HLS); the route fills in the URL.
    return {
      id: `go2rtc:${input.cameraId}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      playbackUrl: '',
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: input.quality,
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // Nothing to revoke while streaming is unsupported.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'These cameras expose no remote controls.');
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    // go2rtc does not record events; report an empty timeline, not an error.
    return { items: [], total: 0 };
  }

  async getEvent(): Promise<CameraEvent> {
    throw new AppError('NOT_FOUND', 'No events are recorded for these cameras.');
  }

  async acknowledgeEventUpstream(): Promise<boolean> {
    return false;
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    return { items: [], total: 0 };
  }

  async getRecording(): Promise<Recording> {
    throw new AppError('NOT_FOUND', 'No recordings are available for these cameras.');
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return {
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      retentionDays: null,
      oldestRecordingAt: null,
    };
  }

  async listServiceHealth(): Promise<OrionisServiceHealth[]> {
    const probe = await this.client.probe('/api/streams');
    return [
      {
        id: 'orionis-go2rtc',
        name: 'Camera streaming (go2rtc)',
        status: probe.ok ? 'healthy' : 'offline',
        version: null,
        uptimeSeconds: null,
        message: probe.ok ? null : (probe.detail ?? 'go2rtc did not respond.'),
        checkedAt: new Date().toISOString(),
      },
    ];
  }

  async runServiceAction(): Promise<{ ok: boolean; message: string }> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'No service actions are available for go2rtc.');
  }
}
