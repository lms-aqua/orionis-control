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
  producers?: { url?: string; medias?: string[] | null }[] | null;
  consumers?: unknown[] | null;
}

interface WyzeCameraMetadata {
  name?: string;
  nickname?: string;
  model?: string;
  model_name?: string;
  firmware?: string;
  fw_version?: string;
  state?: string;
}

type SnapshotResult = { bytes: Buffer; contentType: string; capturedAt: string };

/**
 * Snapshot freshness policy. go2rtc's frame.jpeg is a ~1.7s on-demand transcode
 * on EVERY call (measured; it never reuses a warm one), so it can never be made
 * instant on the request path. Instead the last decoded frame is served
 * immediately and a fresh grab runs in the background — a security thumbnail a
 * couple of seconds old is indistinguishable from live, and every request after
 * the first returns in microseconds.
 */
const SNAPSHOT_FRESH_MS = 2_000; // younger than this: serve as-is, no refresh
const SNAPSHOT_MAX_SERVE_MS = 10 * 60_000; // older than this: stop serving stale
// Background warmer: keep a recently-viewed camera's frame ready so even the
// first request after switching screens is instant. Demand-gated — a camera is
// only warmed while it has been asked for in the last WARM_IDLE_MS, so idle
// cameras cost nothing.
const SNAPSHOT_WARM_REFRESH_MS = 10_000;
const SNAPSHOT_WARM_IDLE_MS = 5 * 60_000;

const CAPABILITIES = {
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
  // Filled in per-instance: WebRTC is only offered when it is switched on,
  // because the app picks the first protocol it prefers and a protocol that is
  // advertised but not working end-to-end shows up as a black player.
  protocols: ['hls'] as StreamProtocol[],
  qualities: ['auto', 'low', 'medium', 'high'] as StreamQuality[],
};

export class Go2rtcOrionisAdapter implements OrionisAdapter {
  readonly kind = 'http' as const;
  readonly configured = true;
  // go2rtc restreams video; nothing in it analyses a frame. No camera behind
  // it reports MotionSensor or ObjectDetector either, so events can never
  // arrive and the app must say so rather than showing an empty list.
  readonly eventDetection = false;
  private readonly client: UpstreamClient;
  private readonly labels: Record<string, { name: string; location: string | null }>;
  /** Present only when a MediaMTX playback server is configured. */
  private readonly recordings: MediaMtxRecordings | null;
  private readonly protocols: StreamProtocol[];
  private readonly wyzeBridge: UpstreamClient | null;
  private readonly recordingExclude: Set<string>;
  /**
   * Last frame that actually decoded, per camera. go2rtc's frame.jpeg is an
   * on-demand RTSP→JPEG transcode: it is slow (1–6s) and intermittently returns
   * an empty body or a 502 while the source is warming or busy. For a grid
   * thumbnail a frame a few seconds old is far better than a spinner or an
   * error, so a failed grab falls back to the most recent good frame.
   */
  private readonly lastSnapshot = new Map<
    string,
    { bytes: Buffer; capturedAt: string; at: number }
  >();
  /** One in-flight frame grab per camera, so a burst of tile requests and the
   *  background refresh collapse onto a single upstream transcode. */
  private readonly snapshotInFlight = new Map<string, Promise<SnapshotResult | null>>();
  /** Whether to keep recently-viewed cameras warm in the background. */
  private readonly snapshotWarm: boolean;
  /** camera id → epoch ms until which it should stay warm (extended per request). */
  private readonly snapshotWarmUntil = new Map<string, number>();
  /** cameras with a warm loop currently running, so only one runs per camera. */
  private readonly snapshotWarming = new Set<string>();

  constructor(
    baseUrl: string,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
    labels: Record<string, { name: string; location: string | null }> = {},
    recordings: MediaMtxRecordings | null = null,
    enableWebrtc = false,
    wyzeBridgeUrl = '',
    recordingExclude: string[] = [],
    snapshotWarm = false,
  ) {
    this.recordings = recordings;
    this.snapshotWarm = snapshotWarm;
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
    this.wyzeBridge = wyzeBridgeUrl
      ? new UpstreamClient(
          'wyze-bridge',
          wyzeBridgeUrl,
          { accept: 'application/json' },
          timeoutMs,
          fetchImpl,
        )
      : null;
    this.recordingExclude = new Set(
      recordingExclude.map((value) => value.trim().toLowerCase()).filter(Boolean),
    );
  }

  private async metadata(): Promise<Record<string, WyzeCameraMetadata>> {
    if (!this.wyzeBridge) return {};
    const { data } = await this.wyzeBridge.request<WyzeCameraMetadata[]>({
      path: '/api/cameras',
      cacheTtlMs: 2_000,
    });
    const result: Record<string, WyzeCameraMetadata> = {};
    for (const camera of data ?? []) {
      const id = camera.name;
      if (id) result[id] = camera;
    }
    return result;
  }

  private async streams(): Promise<Record<string, Go2rtcStream>> {
    const { data } = await this.client.request<Record<string, Go2rtcStream>>({
      path: '/api/streams',
      // Camera topology is polled by several dashboard sections at once. A
      // sub-second cache removes duplicate JSON work without hiding a dropout.
      cacheTtlMs: 750,
    });
    const all = data ?? {};
    // Hide internal transcode twins: "<id>_aac" feeds the recorder/HLS with AAC,
    // while "<id>_ll" and "<id>_hq" are WebRTC renditions. They are not cameras
    // in their own right; without this they show as duplicate cameras.
    const visible: Record<string, Go2rtcStream> = {};
    for (const [id, stream] of Object.entries(all)) {
      if (!id.endsWith('_aac') && !id.endsWith('_ll') && !id.endsWith('_hq')) {
        visible[id] = stream;
      }
    }
    return visible;
  }

  private toCamera(
    id: string,
    stream: Go2rtcStream | undefined,
    metadata?: WyzeCameraMetadata,
  ): Camera {
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
    const label = Object.hasOwn(this.labels, id) ? this.labels[id] : undefined;
    const producerMedia = (stream?.producers ?? []).flatMap((producer) => producer.medias ?? []);
    const hasAudio =
      producerMedia.length === 0 ? null : producerMedia.some((media) => /^\s*audio\b/i.test(media));

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
      name: label?.name ?? metadata?.nickname ?? metadata?.name ?? `Camera ${id}`,
      location: label?.location ?? null,
      group: null,
      model: metadata?.model_name ?? metadata?.model ?? 'go2rtc',
      firmware: metadata?.fw_version ?? metadata?.firmware ?? null,
      capabilities: { ...CAPABILITIES, audio: hasAudio, protocols: [...this.protocols] },
      health: {
        status: online ? 'online' : 'offline',
        // A configured recorder is intent, not proof that bytes are reaching
        // disk. MediaMTX playback must expose a recent segment before this can be
        // known, and go2rtc's stream response alone cannot prove that.
        recording: this.recordings === null ? false : null,
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
    const [streams, metadata] = await Promise.all([this.streams(), this.metadata()]);
    return this.roster(Object.keys(streams)).map((id) =>
      this.toCamera(id, streams[id], metadata[id]),
    );
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const [streams, metadata] = await Promise.all([this.streams(), this.metadata()]);
    // A labelled camera that is temporarily gone from go2rtc still resolves — as
    // offline — so opening it shows the reason rather than a 404.
    if (!Object.hasOwn(streams, cameraId) && !Object.hasOwn(this.labels, cameraId)) {
      throw new AppError('NOT_FOUND', `No camera named "${cameraId}" is known to go2rtc.`);
    }
    return this.toCamera(cameraId, streams[cameraId], metadata[cameraId]);
  }

  async getSnapshot(cameraId: string): Promise<SnapshotResult> {
    const streams = await this.streams();
    if (!Object.hasOwn(streams, cameraId)) {
      throw new AppError('NOT_FOUND', `No camera named "${cameraId}" is known to go2rtc.`);
    }

    if (this.snapshotWarm) this.markWarm(cameraId);

    const cached = this.lastSnapshot.get(cameraId);
    const age = cached ? Date.now() - cached.at : Infinity;

    // Warm and recent enough to trust: return instantly. If it is getting old,
    // kick a background refresh (single-flight) but do not wait on it — the next
    // poll picks up the newer frame.
    if (cached && age <= SNAPSHOT_MAX_SERVE_MS) {
      if (age > SNAPSHOT_FRESH_MS) void this.refreshSnapshot(cameraId);
      return { bytes: cached.bytes, contentType: 'image/jpeg', capturedAt: cached.capturedAt };
    }

    // Cold camera (never grabbed, or the cache aged past the serve window): pay
    // the one transcode. A concurrent burst collapses onto the same in-flight
    // grab, so a grid open transcodes each camera once, not once per tile.
    const fresh = await this.refreshSnapshot(cameraId);
    if (fresh) return fresh;

    // Grab failed. Anything we still hold beats a broken tile.
    if (cached) {
      return { bytes: cached.bytes, contentType: 'image/jpeg', capturedAt: cached.capturedAt };
    }
    throw new AppError('CAMERA_OFFLINE', 'The camera did not return a snapshot.');
  }

  /** Grab one JPEG from go2rtc, updating the warm cache. Coalesces concurrent
   *  callers for the same camera onto a single upstream transcode. */
  private refreshSnapshot(cameraId: string): Promise<SnapshotResult | null> {
    const existing = this.snapshotInFlight.get(cameraId);
    if (existing) return existing;

    const work = (async (): Promise<SnapshotResult | null> => {
      try {
        const { data } = await this.client.request<Buffer>({
          path: '/api/frame.jpeg',
          query: { src: cameraId },
          binary: true,
          headers: { accept: 'image/jpeg' },
          maxResponseBytes: 8 * 1024 * 1024,
        });
        if (!data || data.length === 0) return null;
        const capturedAt = new Date().toISOString();
        this.lastSnapshot.set(cameraId, { bytes: data, capturedAt, at: Date.now() });
        return { bytes: data, contentType: 'image/jpeg', capturedAt };
      } catch {
        return null;
      } finally {
        this.snapshotInFlight.delete(cameraId);
      }
    })();

    this.snapshotInFlight.set(cameraId, work);
    return work;
  }

  /** Mark a camera as in-demand and ensure a background warm loop is running. */
  private markWarm(cameraId: string): void {
    this.snapshotWarmUntil.set(cameraId, Date.now() + SNAPSHOT_WARM_IDLE_MS);
    if (this.snapshotWarming.has(cameraId)) return;
    this.snapshotWarming.add(cameraId);
    void this.warmLoop(cameraId);
  }

  /** Refresh a camera's frame on an interval until its demand window lapses.
   *  Timers are unref'd so a warm loop never keeps the process alive at exit. */
  private async warmLoop(cameraId: string): Promise<void> {
    try {
      while (Date.now() < (this.snapshotWarmUntil.get(cameraId) ?? 0)) {
        await this.refreshSnapshot(cameraId);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SNAPSHOT_WARM_REFRESH_MS);
          if (typeof timer.unref === 'function') timer.unref();
        });
      }
    } finally {
      this.snapshotWarming.delete(cameraId);
      this.snapshotWarmUntil.delete(cameraId);
    }
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
      // The signalling proxy resolves this value to the matching go2rtc
      // rendition. Preserve it in the stream row so WHEP negotiation can choose
      // 1080p or the safer 720p source deterministically.
      quality: protocol === 'webrtc' ? input.quality : 'auto',
      iceServers: [],
      supportedQualities: ['auto', 'low', 'medium', 'high'],
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
    // Keep labelled cameras in the recording index even while their live source
    // is offline. Historical footage does not disappear when a camera disconnects.
    return this.roster(Object.keys(streams))
      .map((id) => ({
        id,
        name: (Object.hasOwn(this.labels, id) ? this.labels[id]?.name : null) ?? `Camera ${id}`,
      }))
      .filter(
        (camera) =>
          !this.recordingExclude.has(camera.id.toLowerCase()) &&
          !this.recordingExclude.has((camera.name ?? '').toLowerCase()),
      );
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
