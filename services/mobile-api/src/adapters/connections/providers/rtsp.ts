/**
 * Generic RTSP / go2rtc source.
 *
 * The deliberately dumb provider: it knows about streams and nothing else. A
 * bare RTSP endpoint has no event history, no recordings and no storage
 * accounting, and this says so via `CAPABILITY_UNSUPPORTED` rather than
 * returning empty pages — an empty list reads as "nothing happened today",
 * which is a different and false claim.
 *
 * Two shapes are supported by the same code because they differ only in
 * discovery:
 *
 *   - **go2rtc**: cameras are enumerated from its `/api/streams` endpoint.
 *   - **manual**: a list of `name=rtsp://…` pairs typed by the operator.
 *
 * This is also how lostblink is consumed — it publishes ordinary RTSP through
 * MediaMTX, so it needs no bespoke transport code.
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

export const RTSP_DESCRIPTOR: ProviderDescriptor = {
  id: 'rtsp',
  displayName: 'RTSP / go2rtc',
  summary:
    'Any RTSP source, or a go2rtc instance that publishes several. Live view only — no events, recordings or storage reporting.',
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
      key: 'mode',
      label: 'Discovery',
      type: 'text',
      required: true,
      default: 'go2rtc',
      help: 'go2rtc — enumerate streams automatically. manual — list RTSP URLs yourself.',
    },
    {
      key: 'baseUrl',
      label: 'go2rtc URL',
      type: 'url',
      required: false,
      placeholder: 'http://orionis-guard-go2rtc-1:1984',
      help: 'The go2rtc API. Required when discovery is set to go2rtc.',
    },
    {
      key: 'streams',
      label: 'RTSP streams',
      type: 'text',
      required: false,
      placeholder: 'front_door=rtsp://mediamtx:8554/front_door',
      help: 'One name=url pair per line. Used when discovery is manual.',
    },
  ],
  // Unlike Blink and Wyze, this bridge is a convenience rather than a
  // necessity: manual mode reads cameras straight off their RTSP URLs and
  // needs nothing running. It is offered for the go2rtc discovery mode, where
  // otherwise you have to stand up go2rtc yourself before this provider does
  // anything at all.
  bridge: {
    template: 'go2rtc',
    summary:
      'go2rtc enumerates several RTSP cameras as one source. Orionis can start one for you — or leave discovery on manual and list the URLs yourself, which needs nothing extra.',
    provides: ['baseUrl'],
    // The go2rtc this can start is deliberately empty — see the template. So
    // the address field has to stay reachable: a provisioned instance publishes
    // nothing until someone points it at cameras, and an operator who already
    // runs a go2rtc should be able to say so rather than being handed a second,
    // empty one with no way to name it.
    optional: true,
  },
};

interface Go2rtcStream {
  producers?: { url?: string }[];
  consumers?: unknown[];
}

/**
 * Alternate encodings of a camera, which go2rtc lists as ordinary streams.
 *
 * A single camera commonly appears four times: the source, an AAC-transcoded
 * twin for HLS, a short-keyframe rendition for WebRTC recovery, and a
 * full-resolution one. They are renditions chosen per playback, not four
 * cameras, and listing them as four put four tiles on the wall for one camera.
 *
 * The suffixes are a naming convention rather than anything go2rtc models, so
 * this only drops a name when the base stream is present alongside it — a
 * camera genuinely called `front_ll` with no `front` keeps its tile.
 */
const RENDITION_SUFFIXES = ['_aac', '_hq', '_ll'] as const;

export function isRendition(name: string, streams: Record<string, unknown>): boolean {
  for (const suffix of RENDITION_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const base = name.slice(0, -suffix.length);
    if (base && Object.prototype.hasOwnProperty.call(streams, base)) return true;
  }
  return false;
}

export class RtspProvider implements CameraProvider {
  readonly descriptor = RTSP_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #mode(): 'go2rtc' | 'manual' {
    return String(this.#ctx.settings.mode ?? 'go2rtc') === 'manual' ? 'manual' : 'go2rtc';
  }

  get #baseUrl(): string {
    return String(this.#ctx.settings.baseUrl ?? '').replace(/\/+$/, '');
  }

  /** Parses the `name=url` block into pairs, ignoring blanks and comments. */
  get #manualStreams(): { name: string; url: string }[] {
    return String(this.#ctx.settings.streams ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const idx = line.indexOf('=');
        if (idx <= 0) return null;
        return { name: line.slice(0, idx).trim(), url: line.slice(idx + 1).trim() };
      })
      .filter((x): x is { name: string; url: string } => x !== null && Boolean(x.url));
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    if (this.#mode === 'manual') {
      const count = this.#manualStreams.length;
      return {
        ok: count > 0,
        message: count > 0 ? `${count} stream(s) configured.` : 'No streams are configured.',
        cameraCount: count,
        latencyMs: null,
      };
    }
    if (!this.#baseUrl) {
      return { ok: false, message: 'No go2rtc URL is set.', cameraCount: null, latencyMs: null };
    }
    try {
      const streams = await this.#fetchStreams();
      const count = Object.keys(streams).filter((name) => !isRendition(name, streams)).length;
      // Reaching an empty go2rtc is not success. It answers, so `ok: true` was
      // literally true, and the source then reported healthy over a camera wall
      // with nothing on it — the state a freshly provisioned go2rtc is always
      // in, because the template starts it with `streams: {}` on purpose. Say
      // which end the gap is at instead.
      if (count === 0) {
        return {
          ok: false,
          message:
            'Reached go2rtc, but it publishes no streams. Add cameras to go2rtc, ' +
            'or set discovery to manual and list their RTSP URLs here.',
          cameraCount: 0,
          latencyMs: Date.now() - started,
        };
      }
      return {
        ok: true,
        message: `Reached go2rtc; ${count} stream(s) published.`,
        cameraCount: count,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'go2rtc could not be reached.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async #fetchStreams(): Promise<Record<string, Go2rtcStream>> {
    const response = await this.#ctx.fetchImpl(`${this.#baseUrl}/api/streams`, {
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError('UPSTREAM_ERROR', `go2rtc returned HTTP ${response.status}.`);
    }
    return (await response.json()) as Record<string, Go2rtcStream>;
  }

  async listCameras(): Promise<Camera[]> {
    if (this.#mode === 'manual') {
      return this.#manualStreams.map(({ name }) => this.#camera(name, true));
    }
    const streams = await this.#fetchStreams();
    return Object.entries(streams)
      .filter(([name]) => !isRendition(name, streams))
      .map(([name, stream]) =>
        // A stream with no producer is declared but not receiving; that is
        // offline, not merely absent.
        this.#camera(name, (stream.producers?.length ?? 0) > 0),
      );
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const camera = (await this.listCameras()).find((c) => c.id === cameraId);
    if (!camera) throw AppError.notFound('Camera');
    return camera;
  }

  #camera(name: string, online: boolean): Camera {
    return {
      id: name,
      name: name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      location: null,
      group: null,
      model: null,
      firmware: null,
      capabilities: {
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        // Unknown rather than false: whether a stream carries audio is not
        // discoverable without opening it.
        audio: null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: this.#mode === 'go2rtc',
        protocols: this.#mode === 'go2rtc' ? ['webrtc', 'mjpeg'] : ['hls'],
        qualities: ['auto'],
      },
      health: {
        status: online ? 'online' : 'offline',
        // This provider cannot observe recording state at all; null says so.
        recording: null,
        streaming: online,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: online ? null : 'No producer is publishing to this stream.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    if (this.#mode !== 'go2rtc') {
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        'Snapshots need go2rtc; a bare RTSP URL cannot produce one.',
      );
    }
    const url = `${this.#baseUrl}/api/frame.jpeg?src=${encodeURIComponent(cameraId)}`;
    const response = await this.#ctx.fetchImpl(url, {
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError('CAMERA_OFFLINE', `Could not capture a frame (HTTP ${response.status}).`);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'image/jpeg',
      capturedAt: new Date().toISOString(),
    };
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    if (this.#mode === 'go2rtc') {
      if (!this.#baseUrl) {
        throw new AppError('SERVICE_NOT_CONFIGURED', 'No go2rtc URL is set.');
      }
      const protocol: StreamProtocol = input.preferredProtocols.includes('webrtc')
        ? 'webrtc'
        : 'mjpeg';
      const path =
        protocol === 'webrtc'
          ? `/api/webrtc?src=${encodeURIComponent(input.cameraId)}`
          : `/api/stream.mjpeg?src=${encodeURIComponent(input.cameraId)}`;
      return {
        id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
        cameraId: input.cameraId,
        protocol,
        playbackUrl: `${this.#baseUrl}${path}`,
        expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
        quality: 'auto',
        iceServers: [],
        supportedQualities: ['auto'],
      };
    }

    const stream = this.#manualStreams.find((s) => s.name === input.cameraId);
    if (!stream) throw AppError.notFound('Camera');
    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      // The URL is handed over as-is. It may embed credentials, which is why a
      // stream session is only ever returned to an authenticated caller.
      protocol: 'hls',
      playbackUrl: stream.url,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // Sessions here are just URLs; there is no server-side handle to release.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'RTSP sources expose no camera controls.');
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'RTSP sources have no event history.');
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'RTSP sources have no event history.');
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'RTSP sources do not record.');
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'RTSP sources do not record.');
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
