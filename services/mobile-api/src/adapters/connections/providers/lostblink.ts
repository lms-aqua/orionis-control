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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
    // How hard the bridge works the cameras. These were fixed in the compose
    // template, which meant changing one took an edit to a file in a volume on
    // the server — and the config sidecar rewrote it on the next reconcile
    // anyway. They belong to the connection.
    {
      key: 'liveMode',
      label: 'Live view',
      type: 'text',
      required: false,
      default: 'on_motion',
      help: 'off — clips only. on_motion — stream while something is happening. always — stream continuously, which is the only setting that keeps every camera visible when nothing is going on.',
    },
    {
      key: 'requireBatteryOk',
      label: 'Respect battery level',
      type: 'boolean',
      required: false,
      default: true,
      help: 'Refuses live view on a camera reporting low battery. Turn off only for mains-powered cameras — a wired doorbell, Floodlight or Mini.',
    },
    {
      key: 'dailyBudgetSeconds',
      label: 'Daily live seconds per camera',
      type: 'number',
      required: false,
      default: 1800,
      advanced: true,
      help: 'Live view is continuous radio-on and flattens a Blink battery in 1–3 days. The default is 30 minutes a day per camera; raise it only where mains power makes that moot.',
    },
    {
      key: 'maxSessionsPerHour',
      label: 'Sessions per hour per camera',
      type: 'number',
      required: false,
      default: 6,
      advanced: true,
      help: 'Caps how often a camera may be woken. Raise alongside the daily budget when running continuously.',
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
    // signed-in identity of its own. Handing over the *completed* one is what
    // stops it asking for a second verification code at a console nobody is
    // watching. See `seed_lostblink_credentials` in the applier, which maps
    // these onto blinkpy's own `login_attributes` key names.
    //
    // What makes it durable is the pair `refreshToken` + `hardwareId`. blinkpy
    // 0.25's `Auth.startup()` has exactly two paths: hold both and it silently
    // refreshes the access token, hold either without the other and it drops
    // through to a full OAuth sign-in — which means 2FA, at that console. So
    // these two are not "extra completeness": they are the difference between a
    // bridge that comes back up on its own and one that strands.
    handsOver: {
      settings: [
        'email', // → username
        'tier', // → region_id
        'host', // → host
        'accountId',
        'clientId',
        'userId',
        'hardwareId', // → hardware_id, half the refresh pair
        'tokenExpiresIn', // → expires_in
        'tokenExpiresAt', // → expiration_date
        // Not blinkpy's: the applier compares it against the file already in
        // the volume so a re-seed cannot overwrite a fresher session.
        'tokenIssuedAt',
        'uniqueId',
        'deviceIdentifier',
        // Behaviour, not identity. The template used to hard-code these, so the
        // only way to change one was to edit a file inside a volume — which the
        // config sidecar then overwrote on the next reconcile.
        'liveMode',
        'requireBatteryOk',
        'dailyBudgetSeconds',
        'maxSessionsPerHour',
      ],
      secrets: ['password', 'authToken', 'refreshToken'],
    },
  },
};

/** Blink's production API. Region is negotiated per account after login. */
const BLINK_DEFAULT_TIER = 'rest-prod';
/** Blink's API domain. `host` is `{region}.{this}` — blinkpy's own format. */
const BLINK_URL = 'immedia-semi.com';
/** What blinkpy assumes when a token response omits `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

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

// MARK: Blink OAuth2 endpoints
//
// Blink retired the old `/api/v5/account/login` endpoint (it now answers HTTP
// 426 "an app update is required" to force old clients off) and moved sign-in
// to a browser-style OAuth2 authorization-code + PKCE flow at api.oauth.blink.com:
// GET authorize (establishes a session cookie) -> GET the signin page (carries a
// CSRF token in its HTML) -> POST credentials -> if a second factor is demanded,
// POST the code to 2fa/verify -> GET authorize again to receive an auth `code` on
// the redirect -> exchange that code for tokens -> read tier_info for the account.
//
// Endpoint set, request shapes and user-agent strings are held level with the
// blinkpy reference client — currently 0.25.9, whose `helpers/constants.py` and
// `auth.py` these were checked against. That matters beyond politeness: the
// bridge downstream *is* blinkpy, so a session this gateway mints has to be one
// that version can pick up and refresh without signing in again.
const OAUTH_ORIGIN = 'https://api.oauth.blink.com';
const OAUTH_AUTHORIZE_URL = `${OAUTH_ORIGIN}/oauth/v2/authorize`;
const OAUTH_SIGNIN_URL = `${OAUTH_ORIGIN}/oauth/v2/signin`;
const OAUTH_2FA_VERIFY_URL = `${OAUTH_ORIGIN}/oauth/v2/2fa/verify`;
const OAUTH_TOKEN_URL = `${OAUTH_ORIGIN}/oauth/token`;
const BLINK_TIER_INFO_URL = 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info';
const OAUTH_CLIENT_ID = 'ios';
const OAUTH_SCOPE = 'client';
const OAUTH_REDIRECT_URI = 'immedia-blink://applinks.blink.com/signin/callback';
const BLINK_APP_VERSION = '50.1';
/** Presented on the browser-flow requests; a plausible mobile Safari. */
const OAUTH_WEB_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
/** Presented on the token exchange, matching the native app's client string. */
const OAUTH_TOKEN_USER_AGENT = 'Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0';
/** Presented on the tier_info REST call. */
const BLINK_DEFAULT_USER_AGENT = '27.0ANDROID_28373244';
/** HTTP statuses Blink uses to mean "follow the redirect" (success). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The narrow slice of a Node/undici fetch Response this provider reads. */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

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

/**
 * Camera names this connection has seen publishing, keyed by connection id.
 *
 * MediaMTX only knows about a path while something is publishing to it, and a
 * Blink camera publishes in bursts: Blink caps a live session at 300 seconds
 * and lostblink opens a replacement. Listing only what is live therefore
 * emptied the entire camera wall between sessions — the cameras appeared,
 * vanished, and reappeared depending on when the app happened to ask.
 *
 * A camera that was publishing a minute ago is still a camera. It is reported
 * with `ready: false`, which reads through as offline rather than absent —
 * honest about the state without pretending the camera does not exist.
 *
 * Module-level rather than per-instance because the store rebuilds a provider
 * on every connection write, and an edit to an unrelated setting should not
 * blank the wall. Lost on restart, which is correct: nothing here is worth
 * persisting through one.
 */
const seenCameras = new Map<string, Set<string>>();

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
    // Either the durable account id from a completed sign-in, or a stored OAuth
    // token — tier_info does not always yield an account id, but a token is
    // itself proof the flow finished.
    return Boolean(this.#ctx.settings.accountId) || Boolean(this.#ctx.secrets.authToken);
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

  /** Every camera this connection has seen, live or between sessions. */
  #remember(live: MediaMtxPath[]): Set<string> {
    const seen = seenCameras.get(this.#ctx.connectionId) ?? new Set<string>();
    for (const path of live) seen.add(path.name);
    seenCameras.set(this.#ctx.connectionId, seen);
    return seen;
  }

  async listCameras(): Promise<Camera[]> {
    const live = await this.#paths();
    const byName = new Map(live.map((path) => [path.name, path]));
    // Union, not replacement: a poll landing between two live sessions sees no
    // paths at all, and returning nothing there is what made the wall flicker.
    return [...this.#remember(live)].map((name) =>
      this.#camera(byName.get(name) ?? { name, ready: false }),
    );
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const live = await this.#paths();
    const path = live.find((p) => p.name === cameraId);
    if (path) return this.#camera(path);
    // Opening a camera in the gap between sessions is the common case, not an
    // error — the tile was on screen a moment ago. Report it offline rather
    // than 404ing a camera the user can plainly see.
    if (this.#remember(live).has(cameraId)) {
      return this.#camera({ name: cameraId, ready: false });
    }
    throw AppError.notFound('Camera');
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

  /**
   * Live OAuth sign-in state, held on this instance only between `beginAuth`
   * and `completeAuth`. The store pins the same provider object across both
   * steps (see ConnectionStore #challenges), so the session cookies, PKCE
   * verifier and CSRF token survive the wait for the user's code — and nothing
   * half-authenticated is ever persisted, because it lives here, not in the db.
   */
  #oauth: {
    jar: CookieJar;
    codeVerifier: string;
    codeChallenge: string;
    hardwareId: string;
    csrf: string;
    email: string;
  } | null = null;
  /** Credentials proper: encrypted at rest, never returned by the API. */
  #obtainedSecrets: Record<string, string> = {};
  /** Account id, region tier, hardware id — identifiers, not credentials. */
  #obtainedSettings: Record<string, unknown> = {};

  async beginAuth(): Promise<AuthResult> {
    const email = String(this.#ctx.settings.email ?? '').trim();
    const password = this.#ctx.secrets.password ?? '';
    if (!email || !password) {
      return { status: 'failed', message: 'Enter the Blink email and password first.' };
    }

    const jar = new CookieJar();
    const codeVerifier = base64Url(randomBytes(48));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    // Blink binds the session to a hardware id; a stable UUID per connection
    // lets a later re-sign-in reuse a remembered device instead of always
    // mailing a fresh code.
    const hardwareId = randomUUID().toUpperCase();

    try {
      // 1) authorize — unauthenticated this 302s to the sign-in page, but the
      // point of the call is the session cookies it sets, which the rest of the
      // flow rides on.
      await this.#authorize(jar, hardwareId, codeChallenge);
      // 2) sign-in page — the CSRF token the credential POST must echo is
      // embedded in its HTML.
      const csrf = await this.#signinCsrf(jar);
      if (!csrf) {
        return {
          status: 'failed',
          message: 'Blink’s sign-in page did not return a form token. Try again in a moment.',
        };
      }
      // 3) credentials.
      const outcome = await this.#submitCredentials(jar, csrf, email, password);
      if (outcome.kind === 'failed') return { status: 'failed', message: outcome.message };
      if (outcome.kind === 'complete') {
        return await this.#finish(jar, codeVerifier, hardwareId, email);
      }
      // A second factor is required: hold this session for completeAuth. The
      // store pins the instance across both calls, so this survives the wait.
      this.#oauth = { jar, codeVerifier, codeChallenge, hardwareId, csrf, email };
      const bySms = outcome.channel === 'sms';
      return {
        status: 'challenge',
        challenge: {
          challengeId: hardwareId,
          kind: bySms ? 'sms_code' : 'emailed_code',
          prompt: bySms
            ? 'Blink texted a verification code. Enter it to finish connecting.'
            : 'Blink sent a verification code. Enter it to finish connecting.',
          // What Blink actually reported it sent to, masked; only if Blink named
          // nothing do we fall back to the email on the connection.
          sentTo: outcome.sentTo ?? (bySms ? null : redactEmail(email)),
          // Blink's codes are short-lived; ten minutes is the practical window.
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      };
    } catch (error) {
      return { status: 'failed', message: describeNetworkError(error) };
    }
  }

  async completeAuth(_challengeId: string, code: string): Promise<AuthResult> {
    const state = this.#oauth;
    if (!state) {
      return { status: 'failed', message: 'That verification has expired. Sign in again.' };
    }
    const pin = code.trim();
    if (!/^\d{3,10}$/.test(pin)) {
      return { status: 'failed', message: 'The code should be the digits Blink sent you.' };
    }
    try {
      const verified = await this.#verifyTwoFactor(state.jar, state.csrf, pin);
      if (!verified.ok) {
        return { status: 'failed', message: verified.message };
      }
      const result = await this.#finish(
        state.jar,
        state.codeVerifier,
        state.hardwareId,
        state.email,
      );
      if (result.status === 'complete') this.#oauth = null;
      return result;
    } catch (error) {
      return { status: 'failed', message: describeNetworkError(error) };
    }
  }

  // MARK: OAuth flow steps

  /** The authorize query, identical on both GETs so the issued code binds to us. */
  #authorizeParams(hardwareId: string, codeChallenge: string): URLSearchParams {
    return new URLSearchParams({
      app_brand: 'blink',
      app_version: BLINK_APP_VERSION,
      client_id: OAUTH_CLIENT_ID,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      device_brand: 'Apple',
      device_model: 'iPhone16,1',
      device_os_version: '26.1',
      hardware_id: hardwareId,
      redirect_uri: OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: OAUTH_SCOPE,
    });
  }

  /** GET authorize; returns the raw response so callers can read its redirect. */
  async #authorize(
    jar: CookieJar,
    hardwareId: string,
    codeChallenge: string,
  ): Promise<FetchResponse> {
    const url = `${OAUTH_AUTHORIZE_URL}?${this.#authorizeParams(hardwareId, codeChallenge)}`;
    const res = await this.#ctx.fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': OAUTH_WEB_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...jar.header(),
      },
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    jar.absorb(res);
    return res;
  }

  /**
   * The authorization code, following the post-sign-in redirect chain.
   *
   * Once the session is authenticated, GET authorize redirects to the app's
   * callback carrying a one-time `code`. Blink can insert an intermediate
   * redirect first, and delivers the code in the query on some paths and the
   * URL fragment on others — so follow a bounded chain and check both. Each hop
   * is logged with its code value redacted, so a failure here is diagnosable
   * from the gateway logs without ever writing the credential down.
   */
  async #authorizationCode(jar: CookieJar): Promise<string | null> {
    // Requested with NO query params on purpose. The initial authorize (step 1)
    // registered this authorization request against the session server-side, so
    // re-sending the params here would begin a *fresh* request in an
    // unauthenticated context and bounce straight back to /signin. The bare URL
    // plus the authenticated session cookie is what makes Blink 302 to the
    // callback with the code — matching blinkpy's oauth_get_authorization_code.
    let target: string | null = OAUTH_AUTHORIZE_URL;
    for (let hop = 0; hop < 6 && target; hop++) {
      const res = await this.#ctx.fetchImpl(target, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': OAUTH_WEB_USER_AGENT,
          Accept: '*/*',
          Referer: OAUTH_SIGNIN_URL,
          ...jar.header(),
        },
        signal: AbortSignal.timeout(this.#ctx.timeoutMs),
      });
      jar.absorb(res);
      const location = res.headers.get('location');
      process.stderr.write(
        `[lostblink] authorize hop ${hop}: HTTP ${res.status} -> ${redactLocation(location)}\n`,
      );
      if (!location) return null;
      const code = extractAuthCode(location);
      if (code) return code;
      const next = new URL(location, target).toString();
      if (next.startsWith(OAUTH_SIGNIN_URL)) {
        // Bounced back to the sign-in page: the authenticated session was not
        // carried, so no code will ever come. Say so rather than looping.
        process.stderr.write('[lostblink] authorize bounced back to the sign-in page\n');
        return null;
      }
      target = next;
    }
    return null;
  }

  /** GET the sign-in page and pull the CSRF token out of its HTML. */
  async #signinCsrf(jar: CookieJar): Promise<string | null> {
    const res = await this.#ctx.fetchImpl(OAUTH_SIGNIN_URL, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': OAUTH_WEB_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...jar.header(),
      },
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    jar.absorb(res);
    const html = await res.text();
    const match = html.match(/"csrf-token":"([^"]+)"/);
    return match?.[1] ?? null;
  }

  /** POST credentials. Distinguishes success, a demanded second factor, failure. */
  async #submitCredentials(
    jar: CookieJar,
    csrf: string,
    email: string,
    password: string,
  ): Promise<
    | { kind: 'complete' }
    | { kind: 'twofactor'; channel: TwoFactorChannel; sentTo: string | null }
    | { kind: 'failed'; message: string }
  > {
    const res = await this.#ctx.fetchImpl(OAUTH_SIGNIN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': OAUTH_WEB_USER_AGENT,
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: OAUTH_ORIGIN,
        Referer: OAUTH_SIGNIN_URL,
        ...jar.header(),
      },
      body: new URLSearchParams({ username: email, password, 'csrf-token': csrf }),
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    jar.absorb(res);
    if (REDIRECT_STATUSES.has(res.status)) return { kind: 'complete' };
    // 412, or 202 carrying two-step-verification fields, both mean "code needed".
    // The response body names where the code went and by what channel — Blink
    // often texts it rather than emailing — so parse it for the challenge.
    if (res.status === 412 || res.status === 202) {
      let channel: TwoFactorChannel = null;
      let sentTo: string | null = null;
      try {
        const body = (await res.json()) as Record<string, unknown>;
        // Digits masked so a real phone/email is never written to the log; the
        // keys and structure are what refining this parser needs.
        process.stderr.write(
          `[lostblink] 2fa challenge body: ${maskDigits(JSON.stringify(body)).slice(0, 400)}\n`,
        );
        ({ channel, sentTo } = parseTwoFactorTarget(body));
      } catch {
        // A 412 may carry no body; the fallback wording still makes sense.
      }
      return { kind: 'twofactor', channel, sentTo };
    }
    return { kind: 'failed', message: await describeAuthFailure(res, 'signin') };
  }

  /** POST the emailed/texted code to finish the second factor. */
  async #verifyTwoFactor(
    jar: CookieJar,
    csrf: string,
    code: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const res = await this.#ctx.fetchImpl(OAUTH_2FA_VERIFY_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': OAUTH_WEB_USER_AGENT,
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: OAUTH_ORIGIN,
        Referer: OAUTH_SIGNIN_URL,
        ...jar.header(),
      },
      body: new URLSearchParams({ '2fa_code': code, 'csrf-token': csrf, remember_me: 'false' }),
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    jar.absorb(res);
    // Some responses complete the factor with a redirect instead of a 201 body.
    if (REDIRECT_STATUSES.has(res.status)) return { ok: true };
    if (res.status === 201) {
      try {
        const body = (await res.json()) as { status?: string; message?: string };
        if (body?.status === 'auth-completed') return { ok: true };
        return {
          ok: false,
          message:
            body?.message ??
            'Blink did not confirm that verification code. Request a new code and try again.',
        };
      } catch {
        return {
          ok: false,
          message: 'Blink returned an unreadable response to the verification code. Try again.',
        };
      }
    }
    return { ok: false, message: await describeAuthFailure(res, 'verify') };
  }

  /**
   * From an authenticated session to stored tokens: fetch the authorization
   * code off the redirect, exchange it, and read the account's tier. Shared by
   * the no-2FA and post-2FA paths.
   */
  async #finish(
    jar: CookieJar,
    codeVerifier: string,
    hardwareId: string,
    email: string,
  ): Promise<AuthResult> {
    // Re-request authorize (bare) now that the session is authenticated: Blink
    // 302s to the app callback with a one-time `code`. #authorizationCode follows
    // any intermediate hop and reads the code from the query or fragment.
    const code = await this.#authorizationCode(jar);
    if (!code) {
      return {
        status: 'failed',
        message:
          'Blink verified the code but did not return an authorization code on the final step. ' +
          'Start the sign-in again — if it keeps happening, the gateway logs show where the redirect went.',
      };
    }

    const exchange = await this.#exchangeCode(code, codeVerifier, hardwareId);
    if ('error' in exchange) {
      return { status: 'failed', message: exchange.error };
    }
    const token = exchange.token;
    const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
    if (!accessToken) {
      return {
        status: 'failed',
        message: 'Blink completed sign-in but returned no access token. Try signing in again.',
      };
    }

    const tier = await this.#tierInfo(accessToken);

    const refreshToken = typeof token?.refresh_token === 'string' ? token.refresh_token : '';
    if (!refreshToken) {
      // Not fatal — this sign-in works — but it is the one thing that decides
      // whether the bridge survives its next restart without a fresh code, so
      // it is worth a line in the log rather than a silent degradation.
      process.stderr.write(
        '[lostblink] Blink issued no refresh token; the bridge will need a new code when this one expires\n',
      );
    }

    this.#obtainedSecrets = {
      authToken: accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
    this.#obtainedSettings = this.#identity(email, tier, token, hardwareId);
    return { status: 'complete', message: 'Blink verified this device.' };
  }

  /** Exchange the authorization code for tokens. */
  async #exchangeCode(
    code: string,
    codeVerifier: string,
    hardwareId: string,
  ): Promise<{ token: Record<string, unknown> } | { error: string }> {
    const res = await this.#ctx.fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': OAUTH_TOKEN_USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
      },
      body: new URLSearchParams({
        app_brand: 'blink',
        client_id: OAUTH_CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        hardware_id: hardwareId,
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPE,
      }),
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    if (res.status !== 200) {
      return { error: await describeAuthFailure(res, 'token') };
    }
    try {
      return { token: (await res.json()) as Record<string, unknown> };
    } catch {
      return { error: 'Blink returned an unreadable token response. Try signing in again.' };
    }
  }

  /** Read the account's region and id; non-fatal, tokens are already in hand. */
  async #tierInfo(accessToken: string): Promise<Record<string, unknown>> {
    try {
      const res = await this.#ctx.fetchImpl(BLINK_TIER_INFO_URL, {
        method: 'GET',
        headers: {
          'User-Agent': BLINK_DEFAULT_USER_AGENT,
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.#ctx.timeoutMs),
      });
      if (!res.ok) return {};
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Everything a *different* process needs to reuse this sign-in.
   *
   * None of it is a credential — the tokens are secrets and travel separately.
   * `accountId` doubles as the durable "sign-in completed" signal `#signedIn`
   * reads.
   *
   * The three `token*` values exist because the process on the other side is
   * blinkpy, and blinkpy decides whether to refresh from `expiration_date`
   * rather than by trying the token and handling a 401. Handing over a token
   * with no expiry means it either uses a dead one or refreshes needlessly on
   * every start; both are avoidable by passing on what Blink already told us.
   * Seconds since the epoch, not ISO strings, because that is what blinkpy
   * compares against `time.time()`.
   */
  #identity(
    email: string,
    tier: Record<string, unknown>,
    token: Record<string, unknown> | null,
    hardwareId: string,
  ): Record<string, unknown> {
    const accountId = numberOrNull(tier.account_id) ?? numberOrNull(token?.account_id) ?? null;
    const clientId = numberOrNull(tier.client_id) ?? numberOrNull(token?.client_id) ?? null;
    const userId = numberOrNull(tier.user_id) ?? numberOrNull(token?.user_id) ?? null;
    const region =
      (typeof tier.region_id === 'string' && tier.region_id) ||
      (typeof tier.tier === 'string' && tier.tier) ||
      BLINK_DEFAULT_TIER;
    const issuedAt = Math.floor(Date.now() / 1000);
    const lifetime = numberOrNull(token?.expires_in) ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
    return {
      email,
      tier: region,
      // blinkpy builds this itself from the region on a fresh sign-in, but a
      // seeded session skips the code that would; spell it out.
      host: `${region}.${BLINK_URL}`,
      ...(accountId === null ? {} : { accountId }),
      ...(clientId === null ? {} : { clientId }),
      ...(userId === null ? {} : { userId }),
      tokenExpiresIn: lifetime,
      tokenExpiresAt: issuedAt + lifetime,
      tokenIssuedAt: issuedAt,
      // The client identity Blink verified this device under, kept recoverable.
      uniqueId: this.#ctx.connectionId,
      deviceIdentifier: BLINK_DEVICE_IDENTIFIER,
      hardwareId,
      authMethod: 'oauth2',
    };
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

/** Which way Blink chose to send the code. */
type TwoFactorChannel = 'sms' | 'email' | null;

/** Mask any run of 4+ digits, so a phone or code never lands in a log. */
function maskDigits(text: string): string {
  return text.replace(/\d{4,}/g, '••••');
}

/**
 * The channel and a masked destination from a Blink two-step response.
 *
 * Blink's field names here are undocumented and have changed before, so this
 * sniffs broadly: the channel from any sms/phone/email hint anywhere in the
 * body, and the destination from the common key names, masked before use.
 */
function parseTwoFactorTarget(body: Record<string, unknown>): {
  channel: TwoFactorChannel;
  sentTo: string | null;
} {
  const haystack = JSON.stringify(body).toLowerCase();
  let channel: TwoFactorChannel = null;
  if (/sms|phone|text|mobile|cell/.test(haystack)) channel = 'sms';
  else if (/email|e-mail/.test(haystack)) channel = 'email';

  const candidateKeys = [
    'masked_phone',
    'phone',
    'phone_number',
    'masked_email',
    'email',
    'destination',
    'sent_to',
    'sentTo',
    'target',
    'number',
  ];
  let raw: string | null = null;
  for (const key of candidateKeys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) {
      raw = value.trim();
      break;
    }
    if (value && typeof value === 'object') {
      const inner = value as Record<string, unknown>;
      const nested = inner.last_4_digits ?? inner.last4 ?? inner.number ?? inner.value;
      if (typeof nested === 'string' && nested.trim()) {
        raw = nested.trim();
        break;
      }
    }
  }
  return { channel, sentTo: maskDestination(raw, channel) };
}

/** Present a destination safely: keep Blink's own mask, or make one. */
function maskDestination(value: string | null, channel: TwoFactorChannel): string | null {
  if (!value) return null;
  if (value.includes('@')) return redactEmail(value);
  // Already masked by Blink (a bullet, an asterisk, or a run of x's).
  if (/[•*]|x{2,}/i.test(value)) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 4) return `•••‑${digits.slice(-4)}`;
  if (digits.length > 0 && channel === 'sms') return `•••‑${digits}`;
  return value;
}

/** RFC 7636 base64url (PKCE): URL-safe alphabet, no padding. */
function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The `code` from an OAuth redirect Location — checking query then fragment. */
function extractAuthCode(location: string): string | null {
  const query = location.includes('?')
    ? location.slice(location.indexOf('?') + 1).split('#')[0]
    : '';
  const fragment = location.includes('#') ? location.slice(location.indexOf('#') + 1) : '';
  return new URLSearchParams(query).get('code') ?? new URLSearchParams(fragment).get('code');
}

/**
 * A redirect target reduced to scheme/host/path plus its parameter NAMES — never
 * their values, so an authorization code is never written to the log.
 */
function redactLocation(location: string | null): string {
  if (!location) return '(no Location header)';
  try {
    const url = new URL(location, OAUTH_ORIGIN);
    const query = [...url.searchParams.keys()].join(',');
    const fragment = url.hash
      ? ` #[${[...new URLSearchParams(url.hash.slice(1)).keys()].join(',')}]`
      : '';
    return `${url.protocol}//${url.host}${url.pathname} ?[${query}]${fragment}`;
  } catch {
    return location.split('?')[0] ?? '(unparseable)';
  }
}

/**
 * A specific, user-facing message for a non-success upstream response.
 *
 * Blink's own error body wins when it sends one; otherwise the HTTP status maps
 * to the clearest cause. 406 is deliberately explained as two possibilities:
 * Blink returns it — Cloudflare-fronted, plain-text body, no `Retry-After` and
 * no machine-readable reason — for BOTH a wrong password and a temporary
 * lockout after repeated attempts, so there is no honest way to tell them apart
 * from the response alone.
 */
async function describeAuthFailure(
  res: FetchResponse,
  step: 'signin' | 'verify' | 'token',
): Promise<string> {
  const detail = await bodyMessage(res);
  const wait = retryAfterText(res);
  if (res.status === 429) {
    return `Blink is rate-limiting sign-in after too many attempts${wait || ' — wait a while and try again'}.`;
  }
  if (res.status === 406) {
    return step === 'verify'
      ? 'Blink would not accept that code. It may be wrong or expired — or there have been too many attempts, which Blink blocks for a while. Request a fresh code and try again shortly.'
      : 'Blink would not accept the sign-in. Usually this means the email or password is wrong. It can also mean Blink has temporarily blocked sign-in after several attempts (that clears in about an hour). Double-check the password, then try again.';
  }
  if (res.status === 401 || res.status === 403) {
    return detail ?? 'Blink rejected the email or password. Check them and try again.';
  }
  if (res.status === 400) {
    if (detail) return `Blink rejected the request: ${detail}.`;
    return step === 'token'
      ? 'Blink rejected the sign-in exchange — the session most likely expired. Start the sign-in again.'
      : 'Blink rejected the request. Start the sign-in again.';
  }
  if (res.status === 404) {
    return 'Blink’s sign-in API could not be found — it may have changed again. This needs a gateway update.';
  }
  if (res.status >= 500) {
    return `Blink is having server trouble (HTTP ${res.status})${wait}. Try again in a few minutes.`;
  }
  return detail
    ? `Blink rejected the sign-in: ${detail} (HTTP ${res.status}).`
    : `Blink rejected the sign-in (HTTP ${res.status}).`;
}

/** Blink's own error text, when it sent a JSON body; null for plain-text/empty. */
async function bodyMessage(res: FetchResponse): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    const json = JSON.parse(text) as {
      message?: unknown;
      error_description?: unknown;
      error?: unknown;
    };
    const raw = json.message ?? json.error_description ?? json.error;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch {
    // Not JSON (e.g. Blink's bare "406 Not Acceptable"), or unreadable.
    return null;
  }
}

/** " — try again in about N minutes" from a `Retry-After`, or "" when absent. */
function retryAfterText(res: FetchResponse): string {
  const header = res.headers.get('retry-after');
  if (!header) return '';
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 1
    ? ` — try again in about ${minutes} minute${minutes === 1 ? '' : 's'}`
    : ` — try again in ${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** A friendly message for a thrown fetch error (timeout vs unreachable). */
function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'Blink did not respond in time. Check the connection and try again.';
    }
    if (error.message) return `Could not reach Blink: ${error.message}.`;
  }
  return 'Could not reach Blink. Check the connection and try again.';
}

/**
 * The smallest cookie jar that carries a browser-style flow.
 *
 * Node's `fetch` does not persist cookies between calls, and Blink's OAuth flow
 * depends on the session cookies the first request sets being replayed on every
 * later one. This collects `Set-Cookie` values and offers them back as a header.
 */
class CookieJar {
  readonly #cookies = new Map<string, string>();

  absorb(res: FetchResponse): void {
    const setCookies = (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      if (!pair) continue;
      const idx = pair.indexOf('=');
      if (idx > 0) this.#cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  /** Spread-ready: `{}` when empty, so no bare `Cookie:` header is ever sent. */
  header(): Record<string, string> {
    if (this.#cookies.size === 0) return {};
    return { Cookie: [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
  }
}
