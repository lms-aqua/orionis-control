/**
 * Test harness: an in-memory gateway with a controllable identity provider and
 * swappable adapters. No network, no filesystem, no real credentials.
 */
import { DatabaseSync } from 'node:sqlite';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../../src/config/env.ts';
import { buildServices, type AppServices } from '../../src/services.ts';
import { buildApp, API_PREFIX } from '../../src/app.ts';
import type { OrionisAdapter } from '../../src/adapters/orionis/types.ts';
import type { AdGuardAdapter } from '../../src/adapters/adguard/types.ts';
import { createPkcePair } from '../../src/lib/crypto.ts';

export const ISSUER = 'https://auth.test.invalid';
export const CLIENT_ID = 'orionis-control-mobile';
export const REDIRECT_URI = 'https://gateway.test.invalid/api/mobile/v1/auth/callback';
export const APP_REDIRECT = 'orioniscontrol://auth/callback';

export interface FakeIdentityProvider {
  /** Groups returned in the next id_token. */
  groups: string[];
  subject: string;
  username: string;
  /** Set to make the token endpoint fail. */
  tokenEndpointStatus: number;
  /** Set to force a nonce mismatch (replay simulation). */
  overrideNonce: string | null;
  /** Set to make discovery unreachable. */
  discoveryDown: boolean;
  /** Codes the IdP considers valid. */
  issuedCodes: Set<string>;
  lastAuthorizeUrl: string | null;
  fetch: typeof fetch;
}

export async function createFakeIdp(): Promise<FakeIdentityProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const idp: FakeIdentityProvider = {
    groups: ['orionis-admins'],
    subject: 'user-subject-1',
    username: 'testuser',
    tokenEndpointStatus: 200,
    overrideNonce: null,
    discoveryDown: false,
    issuedCodes: new Set(),
    lastAuthorizeUrl: null,
    fetch: async () => new Response('not wired', { status: 500 }),
  };

  // The nonce the gateway sent, captured from the authorize URL.
  let pendingNonce = '';

  idp.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/.well-known/openid-configuration')) {
      if (idp.discoveryDown) throw new TypeError('fetch failed');
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/api/oidc/authorization`,
        token_endpoint: `${ISSUER}/api/oidc/token`,
        jwks_uri: `${ISSUER}/jwks.json`,
        end_session_endpoint: `${ISSUER}/logout`,
        code_challenge_methods_supported: ['S256'],
      });
    }

    if (url.includes('/jwks.json')) {
      return Response.json({ keys: [jwk] });
    }

    if (url.includes('/api/oidc/token')) {
      if (idp.tokenEndpointStatus !== 200) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: idp.tokenEndpointStatus,
        });
      }
      const body = new URLSearchParams(String(init?.body ?? ''));
      const code = body.get('code') ?? '';
      if (!idp.issuedCodes.has(code)) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      const idToken = await new SignJWT({
        nonce: idp.overrideNonce ?? pendingNonce,
        preferred_username: idp.username,
        name: 'Test User',
        email: 'test@example.invalid',
        groups: idp.groups,
        amr: ['pwd', 'otp'],
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject(idp.subject)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

      return Response.json({ id_token: idToken, access_token: 'upstream-access-token' });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  // Wrap so the harness can record the authorize URL / nonce.
  const inner = idp.fetch;
  idp.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    inner(input, init)) as typeof fetch;

  Object.defineProperty(idp, 'capture', {
    value: (authorizeUrl: string) => {
      idp.lastAuthorizeUrl = authorizeUrl;
      pendingNonce = new URL(authorizeUrl).searchParams.get('nonce') ?? '';
    },
  });

  return idp;
}

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: 'https://gateway.test.invalid',
    ALLOWED_APP_REDIRECT_SCHEMES: 'orioniscontrol',
    SESSION_SIGNING_KEY: 'test-signing-key-that-is-definitely-long-enough-0123456789',
    AUTHELIA_ISSUER_URL: ISSUER,
    AUTHELIA_CLIENT_ID: CLIENT_ID,
    AUTHELIA_CLIENT_SECRET: 'test-client-secret',
    AUTHELIA_REDIRECT_URI: REDIRECT_URI,
    ROLE_VIEWER_GROUPS: 'orionis-viewers',
    ROLE_OPERATOR_GROUPS: 'orionis-operators',
    ROLE_ADMIN_GROUPS: 'orionis-admins',
    DATABASE_URL: ':memory:',
    ACCESS_TOKEN_TTL_SECONDS: '600',
    ...overrides,
  };
}

export interface Harness {
  app: FastifyInstance;
  services: AppServices;
  config: Config;
  idp: FakeIdentityProvider;
  db: DatabaseSync;
  close: () => Promise<void>;
  /** Completes the full sign-in flow and returns usable tokens. */
  signIn: (opts?: { deviceId?: string }) => Promise<{
    accessToken: string;
    refreshToken: string;
    sessionId: string;
  }>;
  auth: (token: string) => Record<string, string>;
}

export async function createHarness(
  opts: {
    env?: Record<string, string>;
    orionis?: OrionisAdapter;
    adguard?: AdGuardAdapter;
  } = {},
): Promise<Harness> {
  const idp = await createFakeIdp();
  const { config } = loadConfig(testEnv(opts.env));
  const db = new DatabaseSync(':memory:');

  const services = buildServices(config, {
    db,
    fetchImpl: idp.fetch,
    orionis: opts.orionis,
    adguard: opts.adguard,
  });
  const app = await buildApp(services);
  await app.ready();

  const signIn: Harness['signIn'] = async ({ deviceId = 'test-device-0001' } = {}) => {
    const pkce = createPkcePair();
    const appState = 'app-state-value-123';

    const loginRes = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/login`,
      query: {
        code_challenge: pkce.challenge,
        state: appState,
        redirect_uri: APP_REDIRECT,
        device_id: deviceId,
      },
    });
    if (loginRes.statusCode !== 302) {
      throw new Error(`login did not redirect: ${loginRes.statusCode} ${loginRes.body}`);
    }

    const authorizeUrl = loginRes.headers.location as string;
    (idp as unknown as { capture: (u: string) => void }).capture(authorizeUrl);
    const gatewayState = new URL(authorizeUrl).searchParams.get('state')!;

    const upstreamCode = `upstream-code-${Math.random().toString(36).slice(2)}`;
    idp.issuedCodes.add(upstreamCode);

    const cbRes = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/auth/callback`,
      query: { code: upstreamCode, state: gatewayState },
    });
    if (cbRes.statusCode !== 302) {
      throw new Error(`callback did not redirect: ${cbRes.statusCode} ${cbRes.body}`);
    }
    const appUrl = new URL(cbRes.headers.location as string);
    const appCode = appUrl.searchParams.get('code');
    if (!appCode) {
      throw new Error(`no app code; error=${appUrl.searchParams.get('error')}`);
    }

    const tokenRes = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/token`,
      payload: {
        code: appCode,
        code_verifier: pkce.verifier,
        device: { deviceId, deviceName: 'Test iPhone', appVersion: '0.1.0' },
      },
    });
    const body = tokenRes.json();
    if (!body.success) throw new Error(`token exchange failed: ${JSON.stringify(body)}`);

    return {
      accessToken: body.data.accessToken,
      refreshToken: body.data.refreshToken,
      sessionId: body.data.session.id,
    };
  };

  return {
    app,
    services,
    config,
    idp,
    db,
    close: async () => {
      await app.close();
      db.close();
    },
    signIn,
    auth: (token: string) => ({ authorization: `Bearer ${token}` }),
  };
}

export { API_PREFIX };
