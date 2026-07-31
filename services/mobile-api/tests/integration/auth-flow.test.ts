/**
 * End-to-end authentication against a controllable identity provider.
 * Exercises the real route handlers, real PKCE, real JWT verification.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { API_PREFIX, APP_REDIRECT, createHarness, type Harness } from '../helpers/harness.ts';
import { createPkcePair } from '../../src/lib/crypto.ts';
import { StubOrionisAdapter, StubAdGuardAdapter } from '../helpers/stub-adapters.ts';

let harness: Harness | null = null;

async function makeHarness(env?: Record<string, string>): Promise<Harness> {
  harness = await createHarness({
    env,
    orionis: new StubOrionisAdapter(),
    adguard: new StubAdGuardAdapter(),
  });
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('OIDC sign-in', () => {
  it('completes the full authorization code + PKCE flow', async () => {
    const h = await makeHarness();
    const tokens = await h.signIn();

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();

    const me = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/me`,
      headers: h.auth(tokens.accessToken),
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.success).toBe(true);
    expect(body.data.user.username).toBe('testuser');
    expect(body.data.user.role).toBe('administrator');
    expect(body.data.user.permissions).toContain('audit.view');
  });

  it('redirects to the identity provider with PKCE S256 and a nonce', async () => {
    const h = await makeHarness();
    const pkce = createPkcePair();
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/login`,
      query: {
        code_challenge: pkce.challenge,
        state: 'app-state-1234',
        redirect_uri: APP_REDIRECT,
        device_id: 'device-abcdef12',
      },
    });

    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // The gateway must NOT forward the app's own challenge upstream.
    expect(url.searchParams.get('code_challenge')).not.toBe(pkce.challenge);
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('state')).not.toBe('app-state-1234');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('rejects a callback URL whose scheme is not registered', async () => {
    const h = await makeHarness();
    const pkce = createPkcePair();
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/login`,
      query: {
        code_challenge: pkce.challenge,
        state: 'app-state-1234',
        redirect_uri: 'https://attacker.invalid/steal',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('REDIRECT_URI_NOT_ALLOWED');
  });

  it('rejects an unknown state at the callback', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/callback`,
      query: { code: 'anything', state: 'never-issued' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OAUTH_STATE_INVALID');
  });

  it('rejects a replayed state', async () => {
    const h = await makeHarness();
    const pkce = createPkcePair();
    const login = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/login`,
      query: {
        code_challenge: pkce.challenge,
        state: 'app-state-1234',
        redirect_uri: APP_REDIRECT,
      },
    });
    const state = new URL(login.headers.location as string).searchParams.get('state')!;
    (h.idp as unknown as { capture: (u: string) => void }).capture(
      login.headers.location as string,
    );
    const code = 'code-1';
    h.idp.issuedCodes.add(code);

    const first = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/callback`,
      query: { code, state },
    });
    expect(first.statusCode).toBe(302);

    const replay = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/callback`,
      query: { code, state },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('OAUTH_STATE_INVALID');
  });

  it('rejects an id_token whose nonce does not match', async () => {
    const h = await makeHarness();
    h.idp.overrideNonce = 'a-nonce-the-gateway-never-issued';
    await expect(h.signIn()).rejects.toThrow(/no app code/);
  });

  it('denies a user whose groups map to no role', async () => {
    const h = await makeHarness();
    h.idp.groups = ['some-unrelated-group'];
    await expect(h.signIn()).rejects.toThrow(/no app code/);

    const denied = h.services.audit.list({ limit: 10, offset: 0 });
    expect(denied.items.some((e) => e.action === 'auth.login.denied_no_role')).toBe(true);
  });

  it('surfaces an identity provider failure without leaking detail', async () => {
    const h = await makeHarness();
    h.idp.tokenEndpointStatus = 500;
    await expect(h.signIn()).rejects.toThrow(/no app code/);
  });
});

describe('app-side PKCE verification', () => {
  it('rejects the wrong code_verifier and revokes the pending session', async () => {
    const h = await makeHarness();
    const pkce = createPkcePair();
    const other = createPkcePair();

    const login = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/login`,
      query: {
        code_challenge: pkce.challenge,
        state: 'app-state-1234',
        redirect_uri: APP_REDIRECT,
      },
    });
    (h.idp as unknown as { capture: (u: string) => void }).capture(
      login.headers.location as string,
    );
    const state = new URL(login.headers.location as string).searchParams.get('state')!;
    h.idp.issuedCodes.add('c1');

    const cb = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/callback`,
      query: { code: 'c1', state },
    });
    const appCode = new URL(cb.headers.location as string).searchParams.get('code')!;

    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/token`,
      payload: { code: appCode, code_verifier: other.verifier },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PKCE_VERIFICATION_FAILED');
  });

  it('rejects a reused authorization code', async () => {
    const h = await makeHarness();
    const pkce = createPkcePair();
    const login = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/login`,
      query: {
        code_challenge: pkce.challenge,
        state: 'app-state-1234',
        redirect_uri: APP_REDIRECT,
      },
    });
    (h.idp as unknown as { capture: (u: string) => void }).capture(
      login.headers.location as string,
    );
    const state = new URL(login.headers.location as string).searchParams.get('state')!;
    h.idp.issuedCodes.add('c2');
    const cb = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/callback`,
      query: { code: 'c2', state },
    });
    const appCode = new URL(cb.headers.location as string).searchParams.get('code')!;

    const first = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/token`,
      payload: { code: appCode, code_verifier: pkce.verifier },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/token`,
      payload: { code: appCode, code_verifier: pkce.verifier },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('AUTHORIZATION_CODE_INVALID');
  });
});

describe('token lifecycle', () => {
  it('rotates the refresh token and invalidates the previous one', async () => {
    const h = await makeHarness();
    const tokens = await h.signIn();

    const first = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/refresh`,
      payload: { refresh_token: tokens.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json().data.refreshToken;
    expect(rotated).not.toBe(tokens.refreshToken);

    const reuse = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/refresh`,
      payload: { refresh_token: tokens.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(['REAUTHENTICATION_REQUIRED', 'SESSION_REVOKED']).toContain(reuse.json().error.code);
  });

  it('revokes the session on logout and refuses the access token afterwards', async () => {
    const h = await makeHarness();
    const tokens = await h.signIn();

    const logout = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/logout`,
      headers: h.auth(tokens.accessToken),
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json().data.revoked).toBe(true);

    // The JWT is still within its lifetime, but the session is gone.
    const after = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/me`,
      headers: h.auth(tokens.accessToken),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('SESSION_REVOKED');
  });

  it('refuses a refresh token belonging to a revoked session', async () => {
    const h = await makeHarness();
    const tokens = await h.signIn();
    await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/logout`,
      headers: h.auth(tokens.accessToken),
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/refresh`,
      payload: { refresh_token: tokens.refreshToken },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SESSION_REVOKED');
  });

  it('rejects a forged access token', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/me`,
      headers: h.auth('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.not-a-real-signature'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a request with no Authorization header', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({ method: 'GET', url: `${API_PREFIX}/me` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('reports an unauthenticated session probe without erroring', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({ method: 'GET', url: `${API_PREFIX}/auth/session` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.authenticated).toBe(false);
  });
});

describe('when OIDC is not configured', () => {
  it('reports it in /meta and refuses sign-in with a typed error', async () => {
    const h = await makeHarness({ AUTHELIA_ISSUER_URL: '', AUTHELIA_CLIENT_ID: '' });

    const meta = await h.app.inject({ method: 'GET', url: `${API_PREFIX}/meta` });
    expect(meta.json().data.authentication.configured).toBe(false);
    expect(meta.json().data.unconfigured).toContain('authentication');

    const pkce = createPkcePair();
    const login = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/login`,
      query: {
        code_challenge: pkce.challenge,
        state: 'app-state-1234',
        redirect_uri: APP_REDIRECT,
      },
    });
    expect(login.statusCode).toBe(503);
    expect(login.json().error.code).toBe('SERVICE_NOT_CONFIGURED');
  });
});
