/**
 * Blink sign-in, and the session it leaves behind for the bridge.
 *
 * The assertions worth having here are not "the OAuth dance completes" — they
 * are about what is *kept* when it does. The process on the other side of the
 * hand-over is blinkpy 0.25, and its `Auth.startup()` has two paths: hold a
 * `refresh_token` and a `hardware_id` and it renews the access token in silence;
 * hold either without the other and it starts a whole new OAuth sign-in, which
 * means Blink mails a verification code to a container log nobody is watching.
 * That failure looks exactly like success from in here — the sign-in worked, the
 * connection saved — so it is tested rather than trusted.
 *
 * The whole flow is driven through a stub `fetchImpl`; nothing reaches Blink.
 */
import { describe, expect, it } from 'vitest';
import {
  LOSTBLINK_DESCRIPTOR,
  LostblinkProvider,
} from '../../src/adapters/connections/providers/lostblink.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

const AUTHORIZE = 'https://api.oauth.blink.com/oauth/v2/authorize';
const SIGNIN = 'https://api.oauth.blink.com/oauth/v2/signin';
const VERIFY_2FA = 'https://api.oauth.blink.com/oauth/v2/2fa/verify';
const TOKEN = 'https://api.oauth.blink.com/oauth/token';
const TIER_INFO = 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info';

interface Options {
  /** How the credential POST answers: straight through, or demanding a code. */
  signin: 'redirect' | 'twofactor';
  /** Omitted to model Blink issuing an access token with no refresh token. */
  refreshToken?: string | null;
  expiresIn?: number | null;
}

/**
 * Blink, reduced to the six answers this flow reads.
 *
 * The two `authorize` GETs are told apart by call order, exactly as the real
 * flow distinguishes them: the first establishes the session, the second — now
 * authenticated — carries the authorization code on its redirect.
 */
function blinkStub(options: Options): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let authorizeCalls = 0;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);

    if (url.startsWith(AUTHORIZE)) {
      authorizeCalls += 1;
      if (authorizeCalls === 1) {
        return new Response(null, {
          status: 302,
          headers: new Headers([
            ['location', SIGNIN],
            ['set-cookie', 'blink_session=abc; Path=/; HttpOnly'],
          ]),
        });
      }
      return new Response(null, {
        status: 302,
        headers: new Headers([
          ['location', 'immedia-blink://applinks.blink.com/signin/callback?code=one-time-code'],
        ]),
      });
    }

    if (url === SIGNIN && (init?.method ?? 'GET') === 'GET') {
      return new Response('<html><script>{"csrf-token":"csrf-value"}</script></html>', {
        status: 200,
        headers: new Headers([['content-type', 'text/html']]),
      });
    }

    if (url === SIGNIN) {
      if (options.signin === 'redirect') {
        return new Response(null, { status: 302, headers: new Headers([['location', '/done']]) });
      }
      return new Response(JSON.stringify({ status: '2fa-required', masked_phone: '5551234567' }), {
        status: 412,
        headers: new Headers([['content-type', 'application/json']]),
      });
    }

    if (url === VERIFY_2FA) {
      return new Response(JSON.stringify({ status: 'auth-completed' }), {
        status: 201,
        headers: new Headers([['content-type', 'application/json']]),
      });
    }

    if (url === TOKEN) {
      const refresh = options.refreshToken === undefined ? 'refresh-value' : options.refreshToken;
      return new Response(
        JSON.stringify({
          access_token: 'access-value',
          token_type: 'Bearer',
          ...(refresh === null ? {} : { refresh_token: refresh }),
          ...(options.expiresIn === null ? {} : { expires_in: options.expiresIn ?? 7200 }),
        }),
        { status: 200, headers: new Headers([['content-type', 'application/json']]) },
      );
    }

    if (url === TIER_INFO) {
      return new Response(JSON.stringify({ tier: 'u011', account_id: 42 }), {
        status: 200,
        headers: new Headers([['content-type', 'application/json']]),
      });
    }

    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function providerFor(options: Options): {
  provider: LostblinkProvider;
  calls: string[];
} {
  const { fetchImpl, calls } = blinkStub(options);
  const ctx: ProviderContext = {
    connectionId: 'conn-1',
    slug: 'blink',
    settings: { email: 'pat@example.invalid' },
    secrets: { password: 'not-a-real-password' },
    fetchImpl,
    timeoutMs: 1000,
  };
  return { provider: new LostblinkProvider(ctx), calls };
}

describe('the Blink session a completed sign-in leaves behind', () => {
  it('keeps the refresh token and hardware id blinkpy needs to renew silently', async () => {
    const { provider } = providerFor({ signin: 'redirect' });

    expect((await provider.beginAuth()).status).toBe('complete');

    const secrets = provider.pendingSecrets();
    const settings = provider.pendingSettings();
    // The pair. Either one alone puts the bridge back at a fresh OAuth login.
    expect(secrets.refreshToken).toBe('refresh-value');
    expect(secrets.authToken).toBe('access-value');
    // Blink rejects a non-UUID hardware_id with a 406, and blinkpy replaces one
    // it cannot parse — which would discard the identity Blink just verified.
    expect(String(settings.hardwareId)).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
    );
  });

  it('records the expiry in the epoch seconds blinkpy compares against', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { provider } = providerFor({ signin: 'redirect', expiresIn: 7200 });
    await provider.beginAuth();
    const settings = provider.pendingSettings();

    // blinkpy's need_refresh() does `expiration_date - time.time() < 60`, so an
    // ISO string here would not compare — it would throw or read as expired.
    expect(settings.tokenExpiresIn).toBe(7200);
    expect(Number(settings.tokenExpiresAt)).toBeGreaterThanOrEqual(before + 7200);
    expect(Number(settings.tokenIssuedAt)).toBeGreaterThanOrEqual(before);
    expect(Number(settings.tokenExpiresAt) - Number(settings.tokenIssuedAt)).toBe(7200);
  });

  it('falls back to blinkpy’s own default when Blink names no lifetime', async () => {
    const { provider } = providerFor({ signin: 'redirect', expiresIn: null });
    await provider.beginAuth();
    // Matching blinkpy's `token_data.get("expires_in", 3600)` keeps both sides
    // believing the same thing about when this token dies.
    expect(provider.pendingSettings().tokenExpiresIn).toBe(3600);
  });

  it('spells out the host in the region.domain form blinkpy builds', async () => {
    const { provider } = providerFor({ signin: 'redirect' });
    await provider.beginAuth();
    const settings = provider.pendingSettings();
    // No scheme: blinkpy stores `{region_id}.{BLINK_URL}` and adds https itself.
    expect(settings.host).toBe('u011.immedia-semi.com');
    expect(settings.tier).toBe('u011');
    expect(settings.accountId).toBe(42);
  });

  it('still completes when Blink issues no refresh token', async () => {
    const { provider } = providerFor({ signin: 'redirect', refreshToken: null });
    expect((await provider.beginAuth()).status).toBe('complete');
    // Degraded, not broken: the session works, and the applier warns that this
    // one will need a new code when it expires. Read once — `pendingSecrets` is
    // a hand-off, and the store is meant to be the only reader.
    const secrets = provider.pendingSecrets();
    expect(secrets.refreshToken).toBeUndefined();
    expect(secrets.authToken).toBe('access-value');
  });

  it('carries the same session through the verification-code path', async () => {
    const { provider, calls } = providerFor({ signin: 'twofactor' });

    const begun = await provider.beginAuth();
    expect(begun.status).toBe('challenge');
    if (begun.status !== 'challenge') return;
    expect(begun.challenge.kind).toBe('sms_code');
    // Blink named a phone; the user is told which one, masked to its last four.
    expect(begun.challenge.sentTo).toBe('•••‑4567');
    // Nothing is kept mid-challenge: a half-authenticated session must not be
    // persisted, let alone handed to a bridge.
    expect(provider.pendingSecrets()).toEqual({});

    const done = await provider.completeAuth(begun.challenge.challengeId, '123456');
    expect(done.status).toBe('complete');
    expect(provider.pendingSecrets().refreshToken).toBe('refresh-value');
    expect(provider.pendingSettings().host).toBe('u011.immedia-semi.com');
    expect(calls).toContain(`POST ${VERIFY_2FA}`);
  });

  it('reports not-signed-in until both halves of a session exist', async () => {
    const base = {
      connectionId: 'conn-1',
      slug: 'blink',
      fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
      timeoutMs: 1000,
    };
    // An account id with no token is a half-written sign-in the bridge cannot
    // resume, and standing a bridge up on it is what mails a second code.
    expect(
      new LostblinkProvider({ ...base, settings: { accountId: 42 }, secrets: {} }).isSignedIn(),
    ).toBe(false);
    expect(
      new LostblinkProvider({
        ...base,
        settings: { accountId: 42 },
        secrets: { authToken: 'access-value' },
      }).isSignedIn(),
    ).toBe(true);
  });
});

describe('what the descriptor promises the applier', () => {
  it('hands over every key the credentials file is built from', () => {
    // `seed_lostblink_credentials` reads these names out of the handover, and a
    // key absent from this list is silently dropped by `resolveHandover` — so a
    // rename here that is not mirrored there degrades to a fresh Blink login
    // with no error anywhere.
    const bridge = LOSTBLINK_DESCRIPTOR.bridge;
    const handed = [...(bridge?.handsOver?.settings ?? []), ...(bridge?.handsOver?.secrets ?? [])];
    for (const key of [
      'email',
      'password',
      'authToken',
      'refreshToken',
      'hardwareId',
      'tokenExpiresIn',
      'tokenExpiresAt',
      'tokenIssuedAt',
      'host',
      'tier',
      'accountId',
      'uniqueId',
      'deviceIdentifier',
    ]) {
      expect(handed, key).toContain(key);
    }
  });

  it('sends both tokens as secrets, never as settings', () => {
    // Settings come back out of the API; a Blink refresh token is a standing
    // grant on the whole account, and is no more returnable than the password.
    const bridge = LOSTBLINK_DESCRIPTOR.bridge;
    expect(bridge?.handsOver?.secrets).toEqual(
      expect.arrayContaining(['authToken', 'refreshToken']),
    );
    for (const key of ['authToken', 'refreshToken']) {
      expect(bridge?.handsOver?.settings ?? [], key).not.toContain(key);
    }
  });
});
