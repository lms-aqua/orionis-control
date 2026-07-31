/**
 * Request context: authentication, authorisation guards and idempotency.
 *
 * Authorisation is enforced here, on the server, for every protected route.
 * The iOS app's own permission checks are presentation only.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppServices } from '../services.ts';
import { AppError } from '../lib/errors.ts';
import { hashToken } from '../lib/crypto.ts';
import { can, type Permission, type Role } from '../auth/roles.ts';
import type { AuditActor } from '../audit/audit.ts';

export interface Principal {
  userId: string;
  username: string;
  role: Role;
  sessionId: string;
  deviceId: string;
  groups: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    services: AppServices;
  }
}

export function actorOf(req: FastifyRequest): AuditActor {
  const p = req.principal;
  return {
    id: p?.userId ?? null,
    name: p?.username ?? null,
    role: p?.role ?? null,
    deviceId: p?.deviceId ?? null,
  };
}

function bearerFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token || null;
}

/**
 * Verifies the access token AND that the underlying session is still live.
 * A revoked session fails immediately even while its JWT is unexpired — token
 * lifetime is short, but revocation must be instant.
 */
export async function authenticate(req: FastifyRequest): Promise<Principal> {
  const token = bearerFrom(req);
  if (!token) {
    throw new AppError('UNAUTHENTICATED', 'This request requires a signed-in session.');
  }

  const claims = await req.services.sessions.verifyAccessToken(token);
  const sessionId = claims.sid;
  const session = req.services.sessions.getSession(sessionId);

  if (!session) {
    throw new AppError('SESSION_REVOKED', 'This session no longer exists. Sign in again.');
  }
  if (session.revokedAt) {
    throw new AppError('SESSION_REVOKED', 'This session was revoked. Sign in again.');
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new AppError('REAUTHENTICATION_REQUIRED', 'This session has expired. Sign in again.');
  }

  const user = req.services.sessions.getUser(session.userId);
  if (!user) {
    req.services.sessions.revokeSession(sessionId, 'user_missing');
    throw new AppError('SESSION_REVOKED', 'The account is no longer available.');
  }

  const principal: Principal = {
    userId: user.id,
    username: user.username,
    // The stored role is authoritative and refreshed at each sign-in, so a
    // group change takes effect at most one access-token lifetime later.
    role: user.role,
    sessionId,
    deviceId: session.deviceId,
    groups: user.groups,
  };
  req.principal = principal;
  return principal;
}

/** Fastify preHandler enforcing authentication. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await authenticate(req);
}

/** Fastify preHandler factory enforcing a specific permission. */
export function requirePermission(permission: Permission) {
  return async function guard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const principal = req.principal ?? (await authenticate(req));
    if (!can(principal.role, permission)) {
      req.services.audit.record({
        action: 'auth.login.denied_no_role',
        actor: actorOf(req),
        outcome: 'denied',
        reason: `missing permission ${permission}`,
        requestId: req.id,
        ip: req.ip,
        metadata: { permission, role: principal.role, path: req.url },
      });
      throw new AppError(
        'INSUFFICIENT_ROLE',
        `Your role (${principal.role}) is not permitted to perform this action.`,
        { requiredPermission: permission },
      );
    }
  };
}

// --- idempotency ------------------------------------------------------------

export interface IdempotencyOutcome<T> {
  replayed: boolean;
  value: T;
}

/**
 * Replay protection for sensitive writes.
 *
 * A repeated key with an identical body returns the stored response. A repeated
 * key with a *different* body is a conflict — that is a client bug or an attack,
 * never something to silently execute twice.
 */
export async function withIdempotency<T>(
  req: FastifyRequest,
  endpoint: string,
  requestBody: unknown,
  execute: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const key = req.headers['idempotency-key'];
  const principal = req.principal;
  if (!key || typeof key !== 'string' || !principal) {
    return { replayed: false, value: await execute() };
  }

  const db = req.services.db;
  const requestHash = hashToken(JSON.stringify(requestBody ?? null));
  const existing = db
    .prepare('SELECT * FROM idempotency_keys WHERE key = ? AND user_id = ? AND endpoint = ?')
    .get(key, principal.userId, endpoint) as Record<string, unknown> | undefined;

  if (existing) {
    if (String(existing.request_hash) !== requestHash) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used with a different request body.',
      );
    }
    return { replayed: true, value: JSON.parse(String(existing.response_json)) as T };
  }

  const value = await execute();
  const now = new Date();
  db.prepare(
    `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, status_code, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    key,
    principal.userId,
    endpoint,
    requestHash,
    200,
    JSON.stringify(value),
    now.toISOString(),
    new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
  );

  return { replayed: false, value };
}
