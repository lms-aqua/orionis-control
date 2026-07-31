/**
 * Authentication routes — the nested-PKCE backend-for-frontend flow.
 *
 *   app          ASWebAuthenticationSession
 *    │  GET /auth/login?code_challenge=…&state=…&redirect_uri=orioniscontrol://…
 *    ▼
 *  gateway  ── generates its OWN state/nonce/PKCE ──▶  Authelia /authorize
 *                                                        (user completes MFA)
 *  gateway  ◀── GET /auth/callback?code&state ─────────  Authelia
 *    │  exchanges code (confidential client + gateway verifier)
 *    │  verifies id_token signature, issuer, audience, nonce
 *    │  maps groups → role, creates session, mints a ONE-TIME app code
 *    ▼
 *   app     302 → orioniscontrol://auth/callback?code=…&state=…
 *    │  POST /auth/token { code, code_verifier }   ← app proves its PKCE leg
 *    ▼
 *   app     receives gateway access + refresh tokens
 *
 * Authelia tokens never reach the device; the app never sees the client secret.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.ts';
import { ok } from '../lib/envelope.ts';
import { createPkcePair, hashToken, randomToken, safeEqual, verifyPkce } from '../lib/crypto.ts';
import { permissionsFor, roleFromGroups } from '../auth/roles.ts';
import { actorOf, authenticate, requireAuth } from '../http/context.ts';

const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const APP_CODE_TTL_MS = 2 * 60 * 1000;

const LoginQuery = z.object({
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256').default('S256'),
  state: z.string().min(8).max(256),
  redirect_uri: z.string().min(1).max(512),
  device_id: z.string().min(8).max(128).optional(),
});

const CallbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const TokenBody = z.object({
  code: z.string().min(10),
  code_verifier: z.string().min(43).max(128),
  device: z
    .object({
      deviceId: z.string().min(8).max(128),
      deviceName: z.string().max(128).optional(),
      deviceModel: z.string().max(128).optional(),
      osVersion: z.string().max(64).optional(),
      appVersion: z.string().max(64).optional(),
    })
    .optional(),
});

const RefreshBody = z.object({
  refresh_token: z.string().min(20),
  device: z
    .object({
      deviceId: z.string().min(8).max(128).optional(),
      deviceName: z.string().max(128).optional(),
      appVersion: z.string().max(64).optional(),
    })
    .optional(),
});

function assertRedirectAllowed(redirectUri: string, allowedSchemes: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new AppError('REDIRECT_URI_NOT_ALLOWED', 'The callback URL is not a valid URL.');
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (!allowedSchemes.map((s) => s.toLowerCase()).includes(scheme)) {
    throw new AppError(
      'REDIRECT_URI_NOT_ALLOWED',
      'That callback URL scheme is not registered with this gateway.',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError(
      'REDIRECT_URI_NOT_ALLOWED',
      'The callback URL must not carry credentials, a query string or a fragment.',
    );
  }
}

/** Builds the app-scheme redirect, preserving the app's own state. */
function appRedirect(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /auth/login ------------------------------------------------------
  app.get('/auth/login', async (req, reply) => {
    const parsed = LoginQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The sign-in request is missing required parameters.',
        {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        },
      );
    }
    const q = parsed.data;
    const { oidc, sessions, audit, config } = req.services;

    assertRedirectAllowed(q.redirect_uri, config.allowedRedirectSchemes);

    if (!oidc.configured) {
      throw AppError.notConfigured('Authelia OIDC');
    }

    sessions.purgeExpired();

    const gatewayPkce = createPkcePair();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const now = Date.now();

    req.services.db
      .prepare(
        `INSERT INTO auth_transactions (state, nonce, gateway_verifier, app_challenge, app_state,
           app_redirect_uri, device_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state,
        nonce,
        gatewayPkce.verifier,
        q.code_challenge,
        q.state,
        q.redirect_uri,
        q.device_id ?? null,
        new Date(now).toISOString(),
        new Date(now + TRANSACTION_TTL_MS).toISOString(),
      );

    const authorizeUrl = await oidc.authorizationUrl({
      state,
      nonce,
      codeChallenge: gatewayPkce.challenge,
    });

    audit.record({
      action: 'auth.login.started',
      actor: { id: null, name: null, role: null, deviceId: q.device_id ?? null },
      outcome: 'success',
      requestId: req.id,
      ip: req.ip,
    });

    return reply.redirect(authorizeUrl, 302);
  });

  // --- GET /auth/callback ---------------------------------------------------
  app.get('/auth/callback', async (req, reply) => {
    const q = CallbackQuery.parse(req.query);
    const { oidc, sessions, audit, config, db } = req.services;

    if (!q.state) {
      throw new AppError('OAUTH_STATE_INVALID', 'The sign-in response has no state parameter.');
    }

    const tx = db.prepare('SELECT * FROM auth_transactions WHERE state = ?').get(q.state) as
      Record<string, unknown> | undefined;

    if (!tx) {
      throw new AppError(
        'OAUTH_STATE_INVALID',
        'This sign-in attempt is unknown or has already completed. Start again.',
      );
    }
    if (tx.consumed_at) {
      throw new AppError('OAUTH_STATE_INVALID', 'This sign-in attempt was already used.');
    }
    if (new Date(String(tx.expires_at)).getTime() < Date.now()) {
      db.prepare('DELETE FROM auth_transactions WHERE state = ?').run(q.state);
      throw new AppError('OAUTH_STATE_INVALID', 'This sign-in attempt expired. Start again.');
    }

    db.prepare('UPDATE auth_transactions SET consumed_at = ? WHERE state = ?').run(
      new Date().toISOString(),
      q.state,
    );

    const redirectBase = String(tx.app_redirect_uri);
    const appState = String(tx.app_state);

    // Authelia reported a problem (cancelled MFA, denied consent, lockout…).
    if (q.error) {
      audit.record({
        action: 'auth.login.failed',
        actor: { id: null, name: null, role: null, deviceId: (tx.device_id as string) ?? null },
        outcome: 'failure',
        reason: q.error,
        requestId: req.id,
        ip: req.ip,
      });
      const code = q.error === 'access_denied' ? 'ACCESS_DENIED' : 'LOGIN_FAILED';
      return reply.redirect(appRedirect(redirectBase, { error: code, state: appState }), 302);
    }

    if (!q.code) {
      return reply.redirect(
        appRedirect(redirectBase, { error: 'LOGIN_FAILED', state: appState }),
        302,
      );
    }

    let identity;
    try {
      const tokens = await oidc.exchangeCode(q.code, String(tx.gateway_verifier));
      identity = await oidc.verifyIdToken(tokens.idToken, String(tx.nonce));
    } catch (err) {
      audit.record({
        action: 'auth.login.failed',
        actor: { id: null, name: null, role: null, deviceId: (tx.device_id as string) ?? null },
        outcome: 'failure',
        reason: err instanceof AppError ? err.code : 'exchange_error',
        requestId: req.id,
        ip: req.ip,
      });
      return reply.redirect(
        appRedirect(redirectBase, { error: 'LOGIN_FAILED', state: appState }),
        302,
      );
    }

    const role = roleFromGroups(identity.groups, config.roles);
    if (!role) {
      // Authenticated, but not authorised for this product.
      audit.record({
        action: 'auth.login.denied_no_role',
        actor: { id: identity.subject, name: identity.username, role: null, deviceId: null },
        outcome: 'denied',
        reason: 'no_mapped_group',
        requestId: req.id,
        ip: req.ip,
        metadata: { groupCount: identity.groups.length },
      });
      return reply.redirect(
        appRedirect(redirectBase, { error: 'NOT_AUTHORIZED', state: appState }),
        302,
      );
    }

    const user = {
      id: identity.subject,
      username: identity.username,
      displayName: identity.displayName,
      email: identity.email,
      role,
      groups: identity.groups,
    };
    sessions.upsertUser(user);

    const deviceId = (tx.device_id as string) ?? `unknown-${randomToken(8)}`;
    const issued = await sessions.createSession(user, { deviceId });

    // One-time code the app trades for tokens, bound to the app's PKCE leg.
    const appCode = randomToken(32);
    db.prepare(
      `INSERT INTO authorization_codes (code_hash, session_id, app_challenge, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      hashToken(appCode),
      issued.sessionId,
      String(tx.app_challenge),
      new Date().toISOString(),
      new Date(Date.now() + APP_CODE_TTL_MS).toISOString(),
    );

    // The refresh token issued above is discarded here: the app receives its
    // own pair from /auth/token once it proves possession of the verifier.
    audit.record({
      action: 'auth.login.succeeded',
      actor: { id: user.id, name: user.username, role, deviceId },
      outcome: 'success',
      requestId: req.id,
      ip: req.ip,
      metadata: { amr: identity.amr, role },
    });

    return reply.redirect(appRedirect(redirectBase, { code: appCode, state: appState }), 302);
  });

  // --- POST /auth/token -----------------------------------------------------
  app.post(
    '/auth/token',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const body = TokenBody.parse(req.body);
      const { db, sessions, audit } = req.services;

      const row = db
        .prepare('SELECT * FROM authorization_codes WHERE code_hash = ?')
        .get(hashToken(body.code)) as Record<string, unknown> | undefined;

      if (!row) {
        throw new AppError(
          'AUTHORIZATION_CODE_INVALID',
          'This authorization code is not recognised.',
        );
      }
      if (row.consumed_at) {
        // Replay: burn the session it belonged to.
        sessions.revokeSession(String(row.session_id), 'authorization_code_replay');
        throw new AppError(
          'AUTHORIZATION_CODE_INVALID',
          'This authorization code was already used. The session has been revoked.',
        );
      }
      if (new Date(String(row.expires_at)).getTime() < Date.now()) {
        throw new AppError('AUTHORIZATION_CODE_INVALID', 'This authorization code has expired.');
      }

      if (!verifyPkce(body.code_verifier, String(row.app_challenge))) {
        sessions.revokeSession(String(row.session_id), 'pkce_verification_failed');
        throw new AppError(
          'PKCE_VERIFICATION_FAILED',
          'The code verifier did not match the challenge presented at sign-in.',
        );
      }

      db.prepare('UPDATE authorization_codes SET consumed_at = ? WHERE code_hash = ?').run(
        new Date().toISOString(),
        hashToken(body.code),
      );

      const session = sessions.getSession(String(row.session_id));
      if (!session || session.revokedAt) {
        throw new AppError('SESSION_REVOKED', 'The session for this code is no longer valid.');
      }
      const user = sessions.getUser(session.userId);
      if (!user) throw new AppError('SESSION_REVOKED', 'The account is no longer available.');

      // Rotate onto a fresh refresh token now held only by the device.
      const refreshToken = randomToken(32);
      db.prepare(
        'UPDATE sessions SET refresh_token_hash = ?, device_name = COALESCE(?, device_name), device_model = COALESCE(?, device_model), os_version = COALESCE(?, os_version), app_version = COALESCE(?, app_version) WHERE id = ?',
      ).run(
        hashToken(refreshToken),
        body.device?.deviceName ?? null,
        body.device?.deviceModel ?? null,
        body.device?.osVersion ?? null,
        body.device?.appVersion ?? null,
        session.id,
      );

      const accessToken = await sessions.signAccessToken(user, session.id, session.deviceId);

      audit.record({
        action: 'auth.refresh.succeeded',
        actor: { id: user.id, name: user.username, role: user.role, deviceId: session.deviceId },
        outcome: 'success',
        reason: 'initial_token_exchange',
        requestId: req.id,
        ip: req.ip,
      });

      return ok(
        {
          accessToken,
          refreshToken,
          tokenType: 'Bearer' as const,
          expiresIn: req.services.config.accessTokenTtlSeconds,
          refreshExpiresIn: req.services.config.refreshTokenTtlSeconds,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
            role: user.role,
            groups: user.groups,
            permissions: permissionsFor(user.role),
          },
          session: { id: session.id, deviceId: session.deviceId },
        },
        req.id,
      );
    },
  );

  // --- POST /auth/refresh ---------------------------------------------------
  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const body = RefreshBody.parse(req.body);
      const { sessions, audit } = req.services;

      try {
        const issued = await sessions.refresh(body.refresh_token, {
          deviceId: body.device?.deviceId ?? '',
          deviceName: body.device?.deviceName ?? null,
          appVersion: body.device?.appVersion ?? null,
        });
        const session = sessions.getSession(issued.sessionId);
        const user = session ? sessions.getUser(session.userId) : null;

        audit.record({
          action: 'auth.refresh.succeeded',
          actor: {
            id: user?.id ?? null,
            name: user?.username ?? null,
            role: user?.role ?? null,
            deviceId: session?.deviceId ?? null,
          },
          outcome: 'success',
          requestId: req.id,
          ip: req.ip,
        });

        return ok(
          {
            accessToken: issued.accessToken,
            refreshToken: issued.refreshToken,
            tokenType: issued.tokenType,
            expiresIn: issued.expiresIn,
            refreshExpiresIn: issued.refreshExpiresIn,
          },
          req.id,
        );
      } catch (err) {
        if (err instanceof AppError && err.code === 'SESSION_REVOKED') {
          audit.record({
            action: 'auth.refresh.reuse_detected',
            actor: { id: null, name: null, role: null, deviceId: body.device?.deviceId ?? null },
            outcome: 'denied',
            reason: 'refresh_token_reuse',
            requestId: req.id,
            ip: req.ip,
          });
        }
        throw err;
      }
    },
  );

  // --- POST /auth/logout ----------------------------------------------------
  app.post('/auth/logout', { preHandler: requireAuth }, async (req) => {
    const principal = req.principal!;
    const { sessions, audit, push, oidc } = req.services;

    sessions.revokeSession(principal.sessionId, 'user_logout');
    push.removeDevice(principal.userId, principal.deviceId);

    audit.record({
      action: 'auth.logout',
      actor: actorOf(req),
      outcome: 'success',
      requestId: req.id,
      ip: req.ip,
    });

    return ok(
      {
        revoked: true,
        // The app opens this (if present) in a web session to clear the IdP
        // cookie too; a null value simply means Authelia exposes no such URL.
        endSessionUrl: await oidc.endSessionUrl(),
      },
      req.id,
    );
  });

  // --- GET /me --------------------------------------------------------------
  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const principal = req.principal!;
    const { sessions } = req.services;
    const user = sessions.getUser(principal.userId)!;
    const session = sessions.getSession(principal.sessionId)!;

    return ok(
      {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: user.email,
          role: user.role,
          groups: user.groups,
          permissions: permissionsFor(user.role),
        },
        session: {
          id: session.id,
          deviceId: session.deviceId,
          deviceName: session.deviceName,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
          expiresAt: session.expiresAt,
        },
      },
      req.id,
    );
  });

  // --- GET /auth/session (lightweight liveness check used at cold start) ----
  app.get('/auth/session', async (req) => {
    try {
      const principal = await authenticate(req);
      return ok(
        { authenticated: true, role: principal.role, sessionId: principal.sessionId },
        req.id,
      );
    } catch (err) {
      if (err instanceof AppError) {
        return ok({ authenticated: false, reason: err.code }, req.id);
      }
      throw err;
    }
  });
}

export const __testing = { assertRedirectAllowed, appRedirect, safeEqual };
