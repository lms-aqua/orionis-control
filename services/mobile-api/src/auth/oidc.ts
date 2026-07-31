/**
 * Authelia OpenID Connect client (gateway side).
 *
 * The gateway is a *confidential* client: the client secret never leaves the
 * server. The iOS app is never given Authelia tokens — it receives only the
 * gateway's own short-lived session tokens.
 *
 * Discovery documents and JWKS are cached with a bounded TTL so a brief
 * Authelia outage does not immediately break sign-in.
 */
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import type { OidcConfig } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import { redactUrl } from '../lib/redact.ts';

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

export interface IdentityClaims {
  subject: string;
  username: string;
  displayName: string | null;
  email: string | null;
  groups: string[];
  amr: string[];
  authTime: number | null;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;

export class OidcClient {
  private discovery: { doc: DiscoveryDocument; fetchedAt: number } | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly cfg: OidcConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return this.cfg.configured;
  }

  private assertConfigured(): void {
    if (!this.cfg.configured) throw AppError.notConfigured('Authelia OIDC');
  }

  async discover(force = false): Promise<DiscoveryDocument> {
    this.assertConfigured();
    const fresh = this.discovery && Date.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS;
    if (fresh && !force) return this.discovery!.doc;

    const url = `${this.cfg.issuerUrl}/.well-known/openid-configuration`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      if (this.discovery) return this.discovery.doc; // serve stale rather than fail
      throw new AppError('UPSTREAM_UNAVAILABLE', 'The identity provider could not be reached.', {
        endpoint: redactUrl(url),
        cause: (err as Error).name,
      });
    }

    if (!res.ok) {
      if (this.discovery) return this.discovery.doc;
      throw new AppError(
        'UPSTREAM_ERROR',
        `The identity provider returned ${res.status} for its discovery document.`,
      );
    }

    const doc = (await res.json()) as DiscoveryDocument;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'The identity provider discovery document is missing required endpoints.',
      );
    }
    if (doc.issuer && doc.issuer.replace(/\/+$/, '') !== this.cfg.issuerUrl) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'The identity provider issuer does not match the configured issuer URL.',
      );
    }
    if (
      doc.code_challenge_methods_supported &&
      !doc.code_challenge_methods_supported.includes('S256')
    ) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'The identity provider does not advertise PKCE S256 support, which this gateway requires.',
      );
    }

    this.discovery = { doc, fetchedAt: Date.now() };
    // The key set must go through the same injected fetch as everything else,
    // otherwise it silently bypasses timeouts, proxies and test doubles.
    this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri), {
      [customFetch]: this.fetchImpl,
    });
    return doc;
  }

  /** Builds the Authelia authorization URL for the gateway's own PKCE leg. */
  async authorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string> {
    const doc = await this.discover();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('scope', this.cfg.scopes);
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ idToken: string; accessToken: string | null }> {
    const doc = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: codeVerifier,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(doc.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'The identity provider could not be reached during token exchange.',
        {
          cause: (err as Error).name,
        },
      );
    }

    if (!res.ok) {
      // Authelia's error body can echo request detail; do not forward it.
      throw new AppError(
        'OAUTH_EXCHANGE_FAILED',
        'The identity provider rejected the authorization code.',
        { status: res.status },
      );
    }

    const json = (await res.json()) as { id_token?: string; access_token?: string };
    if (!json.id_token) {
      throw new AppError(
        'OAUTH_EXCHANGE_FAILED',
        'The identity provider did not return an ID token.',
      );
    }
    return { idToken: json.id_token, accessToken: json.access_token ?? null };
  }

  /** Verifies signature, issuer, audience, expiry and nonce. */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<IdentityClaims> {
    await this.discover();
    if (!this.jwks) {
      throw new AppError('UPSTREAM_ERROR', 'The identity provider key set is unavailable.');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.cfg.issuerUrl,
        audience: this.cfg.clientId,
      }));
    } catch {
      throw new AppError('OAUTH_EXCHANGE_FAILED', 'The identity token failed verification.');
    }

    const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!nonce || nonce !== expectedNonce) {
      throw new AppError(
        'OAUTH_STATE_INVALID',
        'The identity token nonce did not match. The sign-in attempt was discarded.',
      );
    }

    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject) {
      throw new AppError('OAUTH_EXCHANGE_FAILED', 'The identity token has no subject claim.');
    }

    const rawGroups = (payload as Record<string, unknown>)[this.cfg.roleClaim];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.filter((g): g is string => typeof g === 'string')
      : [];

    return {
      subject,
      username:
        (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
        (typeof payload.name === 'string' && payload.name) ||
        subject,
      displayName: typeof payload.name === 'string' ? payload.name : null,
      email: typeof payload.email === 'string' ? payload.email : null,
      groups,
      amr: Array.isArray(payload.amr)
        ? (payload.amr as unknown[]).filter((a): a is string => typeof a === 'string')
        : [],
      authTime: typeof payload.auth_time === 'number' ? payload.auth_time : null,
    };
  }

  /** Best-effort upstream logout; failure never blocks local revocation. */
  async endSessionUrl(): Promise<string | null> {
    if (!this.cfg.configured) return null;
    try {
      const doc = await this.discover();
      return doc.end_session_endpoint ?? null;
    } catch {
      return null;
    }
  }
}
