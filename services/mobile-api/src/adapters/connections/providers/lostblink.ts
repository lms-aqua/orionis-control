/**
 * Blink cameras via a lostblink instance.
 *
 * lostblink terminates Blink's proprietary IMMI/RTSPS transports and republishes
 * each camera to MediaMTX as ordinary RTSP, so this provider does no Blink
 * protocol work itself — it discovers what lostblink has published and hands
 * back stream URLs.
 *
 * Two Blink-specific truths shape this provider, and both are visible to the
 * operator rather than buried:
 *
 *   - **Live view drains batteries.** Blink caps a session at 300 seconds and
 *     continuous use flattens a battery camera in days. lostblink enforces its
 *     own budget; nothing here should encourage more sessions than that allows.
 *   - **lostblink is alpha.** Its protocol layer is unit-tested but, as of
 *     writing, unverified against live hardware. The descriptor says so, so the
 *     app can warn before anyone depends on it for security footage.
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
  AuthResult,
  CameraProvider,
  InteractiveAuth,
  ProviderContext,
  ProviderDescriptor,
  ProbeResult,
} from '../provider.ts';

/**
 * Where a bridge lives when nobody says otherwise.
 *
 * These are the addresses the shipped compose template publishes on, so the
 * common case — one lostblink beside one gateway — needs no addresses typed at
 * all. A different deployment overrides them; provisioning overwrites them with
 * whatever it actually created.
 */
const DEFAULT_MEDIAMTX_API_URL = 'http://mediamtx:9997';
const DEFAULT_MEDIAMTX_RTSP_URL = 'rtsp://mediamtx:8554';

export const LOSTBLINK_DESCRIPTOR: ProviderDescriptor = {
  id: 'lostblink',
  displayName: 'Blink (lostblink)',
  summary:
    'Blink cameras through a lostblink bridge. Live view only. lostblink is alpha and unverified against live hardware — do not rely on it as a sole security source.',
  capabilities: {
    snapshots: false,
    liveStream: true,
    // lostblink surfaces Blink motion clips, but this provider does not yet
    // read them; declaring false is honest and can be raised later.
    events: false,
    eventDetection: false,
    recordings: false,
    controls: false,
    storageReporting: false,
    interactiveAuth: true,
  },
  // Order is the order they are asked for, and it matches what the user
  // actually knows: their Blink account. The bridge addresses come last and
  // collapsed, because on a provisioned deployment they are filled in by the
  // applier and nobody should ever see them.
  fields: [
    {
      key: 'email',
      label: 'Blink email',
      type: 'text',
      required: true,
      placeholder: 'you@example.com',
      help: 'The account your Blink cameras are registered to.',
    },
    {
      key: 'password',
      label: 'Blink password',
      type: 'secret',
      required: true,
      help: 'Stored encrypted. Blink will email or text a code to finish signing in.',
    },
    {
      key: 'mediamtxApiUrl',
      label: 'MediaMTX API URL',
      type: 'url',
      // Optional deliberately. Requiring it meant the form refused to save a
      // perfectly good Blink account until someone typed the address of a
      // container that, on a fresh install, does not exist yet.
      required: false,
      advanced: true,
      placeholder: DEFAULT_MEDIAMTX_API_URL,
      default: DEFAULT_MEDIAMTX_API_URL,
      help: 'The MediaMTX control API that lostblink publishes to. Used to discover which cameras are live. Leave as-is unless you run the bridge somewhere else.',
    },
    {
      key: 'rtspBaseUrl',
      label: 'RTSP base URL',
      type: 'url',
      required: false,
      advanced: true,
      placeholder: DEFAULT_MEDIAMTX_RTSP_URL,
      default: DEFAULT_MEDIAMTX_RTSP_URL,
      help: 'Where the published streams are read from. Camera paths are appended to this.',
    },
  ],
  bridge: {
    template: 'lostblink',
    summary:
      'Blink speaks its own transports, so a lostblink bridge and a MediaMTX have to run alongside the gateway to translate them. Orionis can start both for you.',
    provides: ['mediamtxApiUrl', 'rtspBaseUrl'],
    // lostblink holds the Blink session the cameras stream over, so it needs a
    // signed-in identity of its own. Handing over the *completed* one — token,
    // account, and the client identity Blink has already verified — is what
    // stops it asking for a second verification code at a console nobody is
    // watching. See `seed_lostblink_credentials` in the applier: these keys are
    // exactly blinkpy's on-disk credential shape, and every one must be present
    // or blinkpy signs in again from scratch.
    handsOver: {
      settings: [
        'email',
        'tier',
        'accountId',
        'clientId',
        'userId',
        'uniqueId',
        'deviceIdentifier',
      ],
      secrets: ['password', 'authToken'],
    },
  },
};

/** Blink's production API. Region is negotiated per account after login. */
const BLINK_DEFAULT_TIER = 'rest-prod';

/**
 * How this gateway names itself to Blink.
 *
 * Blink binds a verification code to a *client identity*, not to an account, so
 * this string and the per-connection `unique_id` are together what "this device
 * is trusted" means. They are persisted with the rest of the sign-in and handed
 * to the bridge, so the bridge presents the identity Blink has already
 * verified rather than introducing itself as a stranger and being mailed a code.
 */
const BLINK_DEVICE_IDENTIFIER = 'Orionis Control';

interface BlinkLoginResponse {
  account?: {
    account_id?: number;
    client_id?: number;
    user_id?: number;
    tier?: string;
    client_verification_required?: boolean;
    account_verification_required?: boolean;
  };
  auth?: { token?: string };
  message?: string;
  code?: number;
}

/** MediaMTX v3 `/v3/paths/list` shape, narrowed to what is used. */
interface MediaMtxPath {
  name: string;
  ready?: boolean;
  readyTime?: string | null;
  tracks?: string[];
  bytesReceived?: number;
}

interface MediaMtxPathList {
  items?: MediaMtxPath[];
}

export class LostblinkProvider implements CameraProvider, InteractiveAuth {
  readonly descriptor = LOSTBLINK_DESCRIPTOR;
  readonly #ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #apiUrl(): string {
    return (
      String(this.#ctx.settings.mediamtxApiUrl ?? '').replace(/\/+$/, '') ||
      DEFAULT_MEDIAMTX_API_URL
    );
  }

  get #rtspBase(): string {
    return (
      String(this.#ctx.settings.rtspBaseUrl ?? '').replace(/\/+$/, '') || DEFAULT_MEDIAMTX_RTSP_URL
    );
  }

  /**
   * Whether sign-in has got far enough for lostblink to have anything to do.
   *
   * Read from settings, not secrets: the account id is written by a *completed*
   * verification, so its presence is the one durable signal that the PIN step
   * succeeded.
   */
  get #signedIn(): boolean {
    return Boolean(this.#ctx.settings.accountId);
  }

  /**
   * A usable session needs both the account it belongs to and the token that
   * proves it: an accountId with no authToken is a half-written sign-in the
   * bridge cannot reuse, so it does not count as signed in.
   */
  isSignedIn(): boolean {
    return this.#signedIn && Boolean(this.#ctx.secrets.authToken);
  }

  async #paths(): Promise<MediaMtxPath[]> {
    const response = await this.#ctx.fetchImpl(`${this.#apiUrl}/v3/paths/list`, {
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError('UPSTREAM_ERROR', `MediaMTX returned HTTP ${response.status}.`);
    }
    const body = (await response.json()) as MediaMtxPathList;
    return body.items ?? [];
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const paths = await this.#paths();
      const ready = paths.filter((p) => p.ready).length;
      return {
        ok: true,
        message:
          paths.length === 0
            ? 'Reached MediaMTX, but lostblink has not published any cameras yet.'
            : `${ready} of ${paths.length} Blink camera(s) are publishing.`,
        cameraCount: paths.length,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      // An unreachable bridge is a normal state on a connection that has just
      // been created, and it is not a reason to call the whole thing broken:
      // the Blink account may be signed in perfectly well. Say which half is
      // missing, because "MediaMTX could not be reached" tells someone who has
      // never heard of MediaMTX nothing they can act on.
      const reason = error instanceof Error ? error.message : 'the bridge did not answer';
      return {
        ok: false,
        message: this.#signedIn
          ? `Signed in to Blink, but no lostblink bridge is answering at ${this.#apiUrl}, so live view is unavailable. Set one up, or point this connection at an existing one.`
          : `No lostblink bridge is answering at ${this.#apiUrl} (${reason}). Blink cameras need one to translate their streams.`,
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    return (await this.#paths()).map((path) => this.#camera(path));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const path = (await this.#paths()).find((p) => p.name === cameraId);
    if (!path) throw AppError.notFound('Camera');
    return this.#camera(path);
  }

  #camera(path: MediaMtxPath): Camera {
    const ready = path.ready === true;
    return {
      id: path.name,
      name: path.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
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
        // Blink cameras do carry audio, but whether this path has an audio
        // track is only knowable from the track list.
        audio: path.tracks ? path.tracks.some((t) => /audio|aac|opus/i.test(t)) : null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: false,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        status: ready ? 'online' : 'offline',
        recording: null,
        streaming: ready,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: path.readyTime ?? null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: ready
          ? null
          : // Idle is the normal resting state for a battery camera, not a
            // fault, and saying "offline" without this reads as broken.
            'No live session. Blink cameras publish only while a live view is open.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'lostblink does not expose stills. A snapshot would require opening a live session, which drains the camera battery.',
    );
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    // No emptiness check: the base falls back to the address the shipped
    // bridge template publishes on, so there is always something to build a
    // URL from. Whether anything is listening there is what `probe` reports.
    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      playbackUrl: `${this.#rtspBase}/${input.cameraId}`,
      // Blink caps a live session at 300 seconds and lostblink splices a
      // replacement before then. Never promise longer than the cap.
      expiresAt: new Date(Date.now() + Math.min(input.ttlSeconds, 300) * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // lostblink owns session lifecycle and its own budget; tearing a session
    // down from here would fight its splice logic.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Blink cameras expose no controls through lostblink.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Blink motion clips are not yet read by this connection.',
    );
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Blink motion clips are not yet read by this connection.',
    );
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'lostblink does not record.');
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'lostblink does not record.');
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }

  // MARK: Interactive sign-in
  //
  // Blink is a two-step login: credentials are accepted, then a PIN is sent out
  // of band and no token is issued until it comes back. The partial state
  // between those steps (account id, client id, region tier) is held in memory
  // on this instance — the store caches provider instances per connection, so
  // the same object serves both calls, and nothing half-authenticated is
  // persisted.

  #pending: {
    accountId: number;
    clientId: number;
    tier: string;
    userId: number | null;
  } | null = null;
  /** Credentials proper: encrypted at rest, never returned by the API. */
  #obtainedSecrets: Record<string, string> = {};
  /** Account id, client id, region tier — identifiers, not credentials. */
  #obtainedSettings: Record<string, unknown> = {};

  get #tier(): string {
    return String(this.#ctx.settings.tier || BLINK_DEFAULT_TIER);
  }

  async beginAuth(): Promise<AuthResult> {
    const email = String(this.#ctx.settings.email ?? '').trim();
    const password = this.#ctx.secrets.password ?? '';
    if (!email || !password) {
      return { status: 'failed', message: 'Enter the Blink email and password first.' };
    }

    let body: BlinkLoginResponse;
    try {
      const response = await this.#ctx.fetchImpl(
        `https://${BLINK_DEFAULT_TIER}.immedia-semi.com/api/v5/account/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            // Blink ties a PIN to a client identity. A stable ID per connection
            // means re-signing in does not trigger a fresh verification every
            // time, which would be a new email to the user on every restart.
            unique_id: this.#ctx.connectionId,
            device_identifier: BLINK_DEVICE_IDENTIFIER,
            reauth: true,
          }),
          signal: AbortSignal.timeout(this.#ctx.timeoutMs),
        },
      );
      body = (await response.json()) as BlinkLoginResponse;
      if (!response.ok) {
        return {
          status: 'failed',
          message: body.message ?? `Blink rejected the sign-in (HTTP ${response.status}).`,
        };
      }
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Blink could not be reached.',
      };
    }

    const account = body.account;
    const accountId = account?.account_id;
    const clientId = account?.client_id;
    if (!accountId || !clientId) {
      return {
        status: 'failed',
        message: body.message ?? 'Blink returned an unexpected response.',
      };
    }
    const tier = account?.tier ?? BLINK_DEFAULT_TIER;
    // Absent on some accounts. Recorded when present because a bridge handed a
    // credential set with a hole in it signs in again from scratch rather than
    // using the session it was given.
    const userId = account?.user_id ?? null;

    const needsVerification =
      account?.client_verification_required === true ||
      account?.account_verification_required === true;

    if (!needsVerification && body.auth?.token) {
      // A trusted client skips the PIN entirely.
      this.#obtainedSecrets = { authToken: body.auth.token };
      this.#obtainedSettings = this.#identity(tier, accountId, clientId, userId);
      return { status: 'complete', message: 'Signed in to Blink.' };
    }

    this.#pending = { accountId, clientId, tier, userId };
    // Held on this instance only. The store pins it for the duration of the
    // challenge and persists nothing until verification succeeds, so an
    // abandoned sign-in leaves no half-authenticated row behind.
    if (body.auth?.token) this.#obtainedSecrets.authToken = body.auth.token;

    return {
      status: 'challenge',
      challenge: {
        challengeId: `${accountId}:${clientId}`,
        kind: 'emailed_code',
        prompt: 'Blink sent a verification code. Enter it to finish connecting.',
        sentTo: redactEmail(email),
        // Blink's PINs are short-lived; ten minutes is the practical window.
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
  }

  async completeAuth(challengeId: string, code: string): Promise<AuthResult> {
    const pending =
      this.#pending ??
      // The instance may have been rebuilt between the two calls; the challenge
      // ID carries enough to continue rather than making the user start over.
      (() => {
        const [a, c] = challengeId.split(':');
        return a && c
          ? {
              accountId: Number(a),
              clientId: Number(c),
              tier: this.#tier,
              // Recovered from a previous sign-in if there was one. Not worth
              // failing the verification over: an absent user id costs the
              // bridge one extra login, not the session.
              userId: numberOrNull(this.#ctx.settings.userId),
            }
          : null;
      })();
    if (!pending) {
      return { status: 'failed', message: 'That verification has expired. Sign in again.' };
    }

    const pin = code.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      return { status: 'failed', message: 'The code should be the digits Blink sent you.' };
    }

    try {
      const response = await this.#ctx.fetchImpl(
        `https://${pending.tier}.immedia-semi.com/api/v4/account/${pending.accountId}/client/${pending.clientId}/pin/verify`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.#authToken ? { 'token-auth': this.#authToken } : {}),
          },
          body: JSON.stringify({ pin }),
          signal: AbortSignal.timeout(this.#ctx.timeoutMs),
        },
      );
      const body = (await response.json()) as { valid?: boolean; message?: string };
      if (!response.ok || body.valid === false) {
        return { status: 'failed', message: body.message ?? 'That code was not accepted.' };
      }
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Blink could not be reached.',
      };
    }

    this.#obtainedSettings = {
      ...this.#obtainedSettings,
      ...this.#identity(pending.tier, pending.accountId, pending.clientId, pending.userId),
    };
    this.#pending = null;
    return { status: 'complete', message: 'Blink verified this device.' };
  }

  /**
   * Everything a *different* process needs to reuse this sign-in.
   *
   * Written as one object rather than assembled at each call site because it is
   * consumed as a set: a bridge handed six of these seven values signs in again
   * from scratch, which is the failure this exists to prevent. None of it is a
   * credential — the token is a secret and travels separately.
   */
  #identity(
    tier: string,
    accountId: number,
    clientId: number,
    userId: number | null,
  ): Record<string, unknown> {
    return {
      tier,
      accountId,
      clientId,
      ...(userId === null ? {} : { userId }),
      // The client identity Blink verified. Stored rather than derived so that
      // what was actually presented stays recoverable even if the derivation
      // ever changes.
      uniqueId: this.#ctx.connectionId,
      deviceIdentifier: BLINK_DEVICE_IDENTIFIER,
    };
  }

  /**
   * The token from the current sign-in, falling back to one stored by an
   * earlier one — the PIN step must send it, and losing it strands the user on
   * a code that will never be accepted.
   */
  get #authToken(): string {
    return this.#obtainedSecrets.authToken ?? this.#ctx.secrets.authToken ?? '';
  }

  /**
   * Returned rather than written: the store is the only writer of secrets, so
   * a provider never needs a database handle.
   */
  pendingSecrets(): Record<string, string> {
    const out = this.#obtainedSecrets;
    this.#obtainedSecrets = {};
    return out;
  }

  pendingSettings(): Record<string, unknown> {
    const out = this.#obtainedSettings;
    this.#obtainedSettings = {};
    return out;
  }
}

/** A stored identifier as a number, or null when it is absent or nonsense. */
function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** "pat@gmail.com" -> "p•••@gmail.com". Enough to recognise, not to harvest. */
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}
