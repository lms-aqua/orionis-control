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

// MARK: Blink OAuth2 endpoints
//
// Blink retired the old `/api/v5/account/login` endpoint (it now answers HTTP
// 426 "an app update is required" to force old clients off) and moved sign-in
// to a browser-style OAuth2 authorization-code + PKCE flow at api.oauth.blink.com:
// GET authorize (establishes a session cookie) -> GET the signin page (carries a
// CSRF token in its HTML) -> POST credentials -> if a second factor is demanded,
// POST the code to 2fa/verify -> GET authorize again to receive an auth `code` on
// the redirect -> exchange that code for tokens -> read tier_info for the account.
// Endpoint set and request shapes mirror the blinkpy reference client.
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
        return await this.#finish(jar, codeVerifier, codeChallenge, hardwareId, email);
      }
      // A second factor is required: hold this session for completeAuth. The
      // store pins the instance across both calls, so this survives the wait.
      this.#oauth = { jar, codeVerifier, codeChallenge, hardwareId, csrf, email };
      return {
        status: 'challenge',
        challenge: {
          challengeId: hardwareId,
          kind: 'emailed_code',
          prompt: 'Blink sent a verification code. Enter it to finish connecting.',
          sentTo: redactEmail(email),
          // Blink's codes are short-lived; ten minutes is the practical window.
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      };
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Blink could not be reached.',
      };
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
      if (!verified) {
        return { status: 'failed', message: 'That code was not accepted.' };
      }
      const result = await this.#finish(
        state.jar,
        state.codeVerifier,
        state.codeChallenge,
        state.hardwareId,
        state.email,
      );
      if (result.status === 'complete') this.#oauth = null;
      return result;
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Blink could not be reached.',
      };
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
  ): Promise<{ kind: 'complete' | 'twofactor' } | { kind: 'failed'; message: string }> {
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
    if (res.status === 412 || res.status === 202) return { kind: 'twofactor' };
    if (res.status === 406) {
      // Blink's response to a wrong password or, after a few tries, a lockout.
      return {
        kind: 'failed',
        message:
          'Blink would not accept the sign-in — usually a wrong password, or too many recent attempts (Blink then locks sign-in for about an hour). Check the password, and if you have been retrying, wait a while.',
      };
    }
    return { kind: 'failed', message: await messageFor(res, 'Blink rejected the sign-in') };
  }

  /** POST the emailed/texted code to finish the second factor. */
  async #verifyTwoFactor(jar: CookieJar, csrf: string, code: string): Promise<boolean> {
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
    if (res.status === 201) {
      try {
        const body = (await res.json()) as { status?: string };
        return body?.status === 'auth-completed';
      } catch {
        return false;
      }
    }
    // Some responses complete the factor with a redirect instead of a 201 body.
    return REDIRECT_STATUSES.has(res.status);
  }

  /**
   * From an authenticated session to stored tokens: fetch the authorization
   * code off the redirect, exchange it, and read the account's tier. Shared by
   * the no-2FA and post-2FA paths.
   */
  async #finish(
    jar: CookieJar,
    codeVerifier: string,
    codeChallenge: string,
    hardwareId: string,
    email: string,
  ): Promise<AuthResult> {
    // GET authorize again — now that the session is authenticated it 302s to the
    // app redirect carrying `?code=`.
    const authRes = await this.#authorize(jar, hardwareId, codeChallenge);
    const location = authRes.headers.get('location');
    const code = location ? new URLSearchParams(location.split('?')[1] ?? '').get('code') : null;
    if (!code) {
      return {
        status: 'failed',
        message: 'Blink signed in but did not return an authorization code. Try again.',
      };
    }

    const token = await this.#exchangeCode(code, codeVerifier, hardwareId);
    const accessToken = typeof token?.access_token === 'string' ? token.access_token : '';
    if (!accessToken) {
      return { status: 'failed', message: 'Blink did not issue a token after sign-in.' };
    }

    const tier = await this.#tierInfo(accessToken);

    this.#obtainedSecrets = {
      authToken: accessToken,
      ...(typeof token?.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
    };
    this.#obtainedSettings = this.#identity(email, tier, token, hardwareId);
    return { status: 'complete', message: 'Blink verified this device.' };
  }

  /** Exchange the authorization code for tokens. */
  async #exchangeCode(
    code: string,
    codeVerifier: string,
    hardwareId: string,
  ): Promise<Record<string, unknown> | null> {
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
    if (res.status !== 200) return null;
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
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
   */
  #identity(
    email: string,
    tier: Record<string, unknown>,
    token: Record<string, unknown> | null,
    hardwareId: string,
  ): Record<string, unknown> {
    const accountId = numberOrNull(tier.account_id) ?? numberOrNull(token?.account_id) ?? null;
    const region =
      (typeof tier.region_id === 'string' && tier.region_id) ||
      (typeof tier.tier === 'string' && tier.tier) ||
      BLINK_DEFAULT_TIER;
    return {
      email,
      tier: region,
      ...(accountId === null ? {} : { accountId }),
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

/** RFC 7636 base64url (PKCE): URL-safe alphabet, no padding. */
function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A human message from an error response body, falling back to the status. */
async function messageFor(res: FetchResponse, fallback: string): Promise<string> {
  try {
    const json = JSON.parse(await res.text()) as { message?: string };
    if (json?.message) return json.message;
  } catch {
    // Not JSON — the status-code fallback below is the honest answer.
  }
  return `${fallback} (HTTP ${res.status}).`;
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
