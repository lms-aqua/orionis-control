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
import { MediaMtxRecordings } from './mediamtx-recordings.ts';
import { UNKNOWN_STORAGE } from './types.ts';
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
  // Filled in per-instance: WebRTC is only offered when it is switched on,
  // because the app picks the first protocol it prefers and a protocol that is
  // advertised but not working end-to-end shows up as a black player.
  protocols: ['hls'] as StreamProtocol[],
  qualities: ['auto'] as StreamQuality[],
};

export class Go2rtcOrionisAdapter implements OrionisAdapter {
  readonly kind = 'http' as const;
  readonly configured = true;
  private readonly client: UpstreamClient;
  private readonly labels: Record<string, { name: string; location: string | null }>;
  /** Present only when a MediaMTX playback server is configured. */
  private readonly recordings: MediaMtxRecordings | null;
  private readonly protocols: StreamProtocol[];

  constructor(
    baseUrl: string,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
    labels: Record<string, { name: string; location: string | null }> = {},
    recordings: MediaMtxRecordings | null = null,
    enableWebrtc = false,
  ) {
    this.recordings = recordings;
    // Advertising a protocol is a promise that it plays. WebRTC stays off until
    // it is verified end-to-end on a real network, so the app is never steered
    // onto a path that renders nothing.
    this.protocols = enableWebrtc
      ? (['webrtc', 'hls'] as StreamProtocol[])
      : (['hls'] as StreamProtocol[]);
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
    // A configured camera that has dropped out of go2rtc entirely (its source
    // went unreachable, so the sync pruned it) is still a camera the user owns.
    // Rather than have it vanish from the app, it is surfaced as offline with a
    // reason — but only when we have a label for it, so an unknown stream id is
    // never invented into a camera.
    const knownToHub = stream !== undefined;
    const online = Boolean(stream?.producers && stream.producers.length > 0);
    // go2rtc names its streams after the upstream device id. A configured label
    // turns that into something recognisable; without one, the id is shown
    // as-is rather than guessed at.
    const label = this.labels[id];

    // Say plainly why nothing is playing, so the app can show a real reason when
    // the camera is tapped instead of a blank failure.
    let message: string | null = null;
    if (!online) {
      message = knownToHub
        ? 'This camera is connected but is not sending video right now.'
        : 'This camera is offline and not reachable on the network right now. ' +
          'It will come back on its own once it reconnects.';
    }

    return {
      id,
      name: label?.name ?? `Camera ${id}`,
      location: label?.location ?? null,
      group: null,
      model: 'go2rtc',
      firmware: null,
      capabilities: { ...CAPABILITIES, protocols: [...this.protocols] },
      health: {
        status: online ? 'online' : 'offline',
        // MediaMTX records every camera it pulls continuously, so a live camera
        // with a recorder configured is genuinely recording right now.
        recording: online && this.recordings !== null,
        streaming: online,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: online ? new Date().toISOString() : null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message,
      },
      snapshotPath: `/cameras/${encodeURIComponent(id)}/snapshot`,
    };
  }

  /** Every id we should show: whatever go2rtc has, plus every labelled camera. */
  private roster(streamIds: string[]): string[] {
    const ids = new Set<string>([...streamIds, ...Object.keys(this.labels)]);
    return [...ids].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  }

  async listCameras(): Promise<Camera[]> {
    const streams = await this.streams();
    return this.roster(Object.keys(streams)).map((id) => this.toCamera(id, streams[id]));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const streams = await this.streams();
    // A labelled camera that is temporarily gone from go2rtc still resolves — as
    // offline — so opening it shows the reason rather than a 404.
    if (!(cameraId in streams) && !(cameraId in this.labels)) {
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
    // Both go2rtc data planes are proxied by the gateway's /stream/:id routes —
    // HLS relay or the WebRTC signalling proxy — so go2rtc is never exposed. The
    // route fills in the token-bound playbackUrl and mints TURN ICE servers; this
    // just carries the negotiated protocol through.
    const wantsWebrtc = input.preferredProtocols[0] === 'webrtc';
    const protocol: StreamProtocol =
      wantsWebrtc && this.protocols.includes('webrtc') ? 'webrtc' : 'hls';
    return {
      id: `go2rtc:${input.cameraId}`,
      cameraId: input.cameraId,
      protocol,
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

  /** Cameras as {id, name} for the recordings collaborator. */
  private async cameraIndex(): Promise<{ id: string; name: string | null }[]> {
    const streams = await this.streams();
    return Object.keys(streams)
      .sort()
      .map((id) => ({ id, name: this.labels[id]?.name ?? `Camera ${id}` }));
  }

  async listRecordings(query: RecordingQuery): Promise<Page<Recording>> {
    // No recorder configured is an empty history, not a failure.
    if (!this.recordings) return { items: [], total: 0 };
    return this.recordings.list(query, await this.cameraIndex());
  }

  async getRecording(recordingId: string): Promise<Recording> {
    if (!this.recordings) {
      throw new AppError('NOT_FOUND', 'No recordings are available for these cameras.');
    }
    const index = await this.cameraIndex();
    return this.recordings.get(
      recordingId,
      (cameraId) => index.find((camera) => camera.id === cameraId)?.name ?? null,
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    if (!this.recordings) {
      return { ...UNKNOWN_STORAGE };
    }
    return this.recordings.storage(await this.cameraIndex());
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
