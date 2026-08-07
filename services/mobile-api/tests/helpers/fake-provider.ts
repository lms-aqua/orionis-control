/**
 * A camera provider with no upstream, for exercising the store and aggregator.
 *
 * Real providers are covered by their own upstream contracts; what these tests
 * need is control over the two things the plumbing cares about — what a source
 * returns, and whether it fails.
 */
import type {
  Camera,
  CameraControlResult,
  StorageStatus,
} from '../../src/adapters/orionis/types.ts';
import { UNKNOWN_STORAGE } from '../../src/adapters/orionis/types.ts';
import { AppError } from '../../src/lib/errors.ts';
import type {
  AuthResult,
  CameraProvider,
  InteractiveAuth,
  ProbeResult,
  ProviderContext,
  ProviderDescriptor,
} from '../../src/adapters/connections/provider.ts';

export function fakeCamera(id: string, name = id): Camera {
  return {
    id,
    name,
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

export interface FakeProviderOptions {
  id?: string;
  cameras?: string[];
  /** Every read rejects, simulating an unreachable source. */
  failing?: boolean;
  probeOk?: boolean;
  storage?: Partial<StorageStatus>;
  capabilities?: Partial<ProviderDescriptor['capabilities']>;
}

export function fakeDescriptor(options: FakeProviderOptions = {}): ProviderDescriptor {
  return {
    id: options.id ?? 'fake',
    displayName: 'Fake source',
    summary: 'A source that exists only in tests.',
    capabilities: {
      snapshots: true,
      liveStream: true,
      events: true,
      eventDetection: true,
      recordings: true,
      controls: false,
      storageReporting: true,
      interactiveAuth: false,
      ...options.capabilities,
    },
    fields: [
      { key: 'baseUrl', label: 'Base URL', type: 'url', required: false },
      { key: 'apiKey', label: 'API key', type: 'secret', required: false },
    ],
  };
}

export class FakeProvider implements CameraProvider {
  readonly descriptor: ProviderDescriptor;
  readonly ctx: ProviderContext;
  readonly #options: FakeProviderOptions;

  constructor(ctx: ProviderContext, options: FakeProviderOptions = {}) {
    this.ctx = ctx;
    this.#options = options;
    this.descriptor = fakeDescriptor(options);
  }

  #guard(): void {
    if (this.#options.failing) throw new AppError('UPSTREAM_UNAVAILABLE', 'Fake source is down.');
  }

  async probe(): Promise<ProbeResult> {
    const ok = this.#options.probeOk ?? !this.#options.failing;
    return {
      ok,
      message: ok ? 'Fake source reachable.' : 'Fake source is down.',
      cameraCount: ok ? (this.#options.cameras ?? []).length : null,
      latencyMs: ok ? 5 : null,
    };
  }

  async listCameras(): Promise<Camera[]> {
    this.#guard();
    return (this.#options.cameras ?? []).map((id) => fakeCamera(id));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    this.#guard();
    if (!(this.#options.cameras ?? []).includes(cameraId)) throw AppError.notFound('Camera');
    return fakeCamera(cameraId);
  }

  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    this.#guard();
    return { bytes: Buffer.from('jpeg'), contentType: 'image/jpeg', capturedAt: '2026-08-06T00:00:00.000Z' };
  }

  async createStreamSession(input: { cameraId: string; ttlSeconds: number }) {
    this.#guard();
    return {
      id: 'stream-1',
      cameraId: input.cameraId,
      protocol: 'hls' as const,
      playbackUrl: `https://fake.invalid/${input.cameraId}`,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: 'auto' as const,
      iceServers: [],
      supportedQualities: ['auto' as const],
    };
  }

  async revokeStreamSession(): Promise<void> {
    this.#guard();
  }

  async invokeControl(): Promise<CameraControlResult> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'No controls.');
  }

  async listEvents() {
    this.#guard();
    return {
      items: (this.#options.cameras ?? []).map((id) => ({
        id: `evt-${id}`,
        cameraId: id,
        cameraName: null,
        type: 'motion' as const,
        severity: 'info' as const,
        occurredAt: `2026-08-0${(this.#options.cameras ?? []).indexOf(id) + 1}T00:00:00.000Z`,
        endedAt: null,
        confidence: null,
        thumbnailPath: null,
        clipPath: null,
        recordingId: null,
        retentionUntil: null,
        acknowledged: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
        note: null,
      })),
      total: null,
    };
  }

  async getEvent(eventId: string) {
    this.#guard();
    const page = await this.listEvents();
    const found = page.items.find((e) => e.id === eventId);
    if (!found) throw AppError.notFound('Event');
    return found;
  }

  async listRecordings() {
    this.#guard();
    return { items: [], total: null };
  }

  async getRecording(): Promise<never> {
    throw AppError.notFound('Recording');
  }

  async getStorageStatus(): Promise<StorageStatus> {
    this.#guard();
    return { ...UNKNOWN_STORAGE, ...this.#options.storage };
  }
}

/** A provider whose upstream demands a code before it will finish signing in. */
export class FakeInteractiveProvider extends FakeProvider implements InteractiveAuth {
  #verified = false;
  #token: string | null = null;

  constructor(ctx: ProviderContext, options: FakeProviderOptions = {}) {
    super(ctx, { ...options, capabilities: { ...options.capabilities, interactiveAuth: true } });
  }

  async beginAuth(): Promise<AuthResult> {
    // The token exists before verification, exactly as Blink's does — which is
    // what makes losing it between the two steps a real failure mode.
    this.#token = 'token-from-step-one';
    return {
      status: 'challenge',
      challenge: {
        challengeId: 'challenge-1',
        kind: 'emailed_code',
        prompt: 'A code was sent.',
        sentTo: 'p•••@example.invalid',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    };
  }

  async completeAuth(challengeId: string, code: string): Promise<AuthResult> {
    if (challengeId !== 'challenge-1') return { status: 'failed', message: 'Unknown challenge.' };
    // Mirrors the upstream requirement: the second step cannot succeed without
    // the state the first step produced.
    if (!this.#token) return { status: 'failed', message: 'The sign-in state was lost.' };
    if (code !== '123456') return { status: 'failed', message: 'That code was not accepted.' };
    this.#verified = true;
    return { status: 'complete', message: 'Verified.' };
  }

  pendingSecrets(): Record<string, string> {
    if (!this.#verified) return {};
    const out = { authToken: this.#token ?? '' };
    this.#token = null;
    return out;
  }

  pendingSettings(): Record<string, unknown> {
    return this.#verified ? { accountId: 42 } : {};
  }
}
