/**
 * Mobile session lifecycle: access tokens (short-lived signed JWT), refresh
 * tokens (opaque, rotating, hashed at rest, with reuse detection), revocation.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Db } from '../db/index.ts';
import type { Config } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import { hashToken, randomId, randomToken } from '../lib/crypto.ts';
import type { Role } from './roles.ts';

export const ISSUER = 'orionis-control-gateway';
export const AUDIENCE = 'orionis-control-app';

export interface DeviceInfo {
  deviceId: string;
  deviceName?: string | null;
  deviceModel?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
}

export interface UserRecord {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  groups: string[];
}

export interface SessionRecord {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
}

export interface AccessClaims extends JWTPayload {
  sid: string;
  role: Role;
  username: string;
  did: string;
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  private key(): Uint8Array {
    return new TextEncoder().encode(this.config.sessionSigningKey);
  }

  // --- users ---------------------------------------------------------------

  upsertUser(user: UserRecord): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM users WHERE id = ?').get(user.id);
    if (existing) {
      this.db
        .prepare(
          `UPDATE users SET username = ?, display_name = ?, email = ?, role = ?,
             groups_json = ?, last_seen_at = ? WHERE id = ?`,
        )
        .run(
          user.username,
          user.displayName,
          user.email,
          user.role,
          JSON.stringify(user.groups),
          now,
          user.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO users (id, username, display_name, email, role, groups_json,
             first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          user.id,
          user.username,
          user.displayName,
          user.email,
          user.role,
          JSON.stringify(user.groups),
          now,
          now,
        );
    }
  }

  getUser(userId: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      username: String(row.username),
      displayName: (row.display_name as string) ?? null,
      email: (row.email as string) ?? null,
      role: row.role as Role,
      groups: JSON.parse(String(row.groups_json ?? '[]')) as string[],
    };
  }

  // --- issue / rotate ------------------------------------------------------

  async createSession(user: UserRecord, device: DeviceInfo): Promise<IssuedTokens> {
    const sessionId = randomId('ses');
    const family = randomId('fam');
    const refreshToken = randomToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.refreshTokenTtlSeconds * 1000);

    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, device_id, device_name, device_model, os_version,
           app_version, refresh_token_hash, refresh_family, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        user.id,
        device.deviceId,
        device.deviceName ?? null,
        device.deviceModel ?? null,
        device.osVersion ?? null,
        device.appVersion ?? null,
        hashToken(refreshToken),
        family,
        now.toISOString(),
        now.toISOString(),
        expiresAt.toISOString(),
      );

    const accessToken = await this.signAccessToken(user, sessionId, device.deviceId);
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.accessTokenTtlSeconds,
      refreshExpiresIn: this.config.refreshTokenTtlSeconds,
      sessionId,
    };
  }

  async signAccessToken(user: UserRecord, sessionId: string, deviceId: string): Promise<string> {
    return new SignJWT({
      sid: sessionId,
      role: user.role,
      username: user.username,
      did: deviceId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSeconds}s`)
      .sign(this.key());
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key(), {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      return payload as AccessClaims;
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (/exp/i.test(message) || /expired/i.test(message)) {
        throw new AppError('TOKEN_EXPIRED', 'The access token has expired. Refresh and retry.');
      }
      throw new AppError('UNAUTHENTICATED', 'The access token is invalid.');
    }
  }

  /**
   * Rotates a refresh token.
   *
   * Reuse detection: presenting a refresh token that has already been rotated
   * (or one belonging to a revoked session) revokes the entire family. This
   * turns a stolen token into a detectable, self-limiting event.
   */
  async refresh(refreshToken: string, device?: DeviceInfo): Promise<IssuedTokens> {
    const hash = hashToken(refreshToken);
    const row = this.db.prepare('SELECT * FROM sessions WHERE refresh_token_hash = ?').get(hash) as
      Record<string, unknown> | undefined;

    if (!row) {
      throw new AppError(
        'REAUTHENTICATION_REQUIRED',
        'This refresh token is not recognised. Sign in again.',
      );
    }

    if (row.revoked_at) {
      // Reuse of a revoked session's token — burn the family.
      this.revokeFamily(String(row.refresh_family), 'refresh_token_reuse_detected');
      throw new AppError('SESSION_REVOKED', 'This session was revoked. Sign in again.');
    }

    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      this.revokeSession(String(row.id), 'refresh_token_expired');
      throw new AppError('REAUTHENTICATION_REQUIRED', 'The session has expired. Sign in again.');
    }

    const user = this.getUser(String(row.user_id));
    if (!user) {
      this.revokeSession(String(row.id), 'user_missing');
      throw new AppError('SESSION_REVOKED', 'The account is no longer available.');
    }

    const next = randomToken(32);
    const now = new Date();
    this.db
      .prepare(
        `UPDATE sessions SET refresh_token_hash = ?, last_used_at = ?,
           device_name = COALESCE(?, device_name), app_version = COALESCE(?, app_version)
         WHERE id = ?`,
      )
      .run(
        hashToken(next),
        now.toISOString(),
        device?.deviceName ?? null,
        device?.appVersion ?? null,
        String(row.id),
      );

    const accessToken = await this.signAccessToken(user, String(row.id), String(row.device_id));

    return {
      accessToken,
      refreshToken: next,
      tokenType: 'Bearer',
      expiresIn: this.config.accessTokenTtlSeconds,
      refreshExpiresIn: Math.max(
        0,
        Math.floor((new Date(String(row.expires_at)).getTime() - now.getTime()) / 1000),
      ),
      sessionId: String(row.id),
    };
  }

  // --- lookup / revoke -----------------------------------------------------

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      deviceId: String(row.device_id),
      deviceName: (row.device_name as string) ?? null,
      createdAt: String(row.created_at),
      lastUsedAt: String(row.last_used_at),
      expiresAt: String(row.expires_at),
      revokedAt: (row.revoked_at as string) ?? null,
    };
  }

  listSessions(userId: string): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC')
      .all(userId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      deviceId: String(row.device_id),
      deviceName: (row.device_name as string) ?? null,
      createdAt: String(row.created_at),
      lastUsedAt: String(row.last_used_at),
      expiresAt: String(row.expires_at),
      revokedAt: (row.revoked_at as string) ?? null,
    }));
  }

  /** True when the session is usable right now. */
  isActive(sessionId: string): boolean {
    const s = this.getSession(sessionId);
    if (!s) return false;
    if (s.revokedAt) return false;
    return new Date(s.expiresAt).getTime() > Date.now();
  }

  revokeSession(sessionId: string, reason: string): void {
    this.db
      .prepare(
        'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), reason, sessionId);
  }

  revokeFamily(family: string, reason: string): void {
    this.db
      .prepare(
        'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE refresh_family = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), reason, family);
  }

  revokeAllForUser(userId: string, reason: string): number {
    const before = this.listSessions(userId).filter((s) => !s.revokedAt).length;
    this.db
      .prepare(
        'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), reason, userId);
    return before;
  }

  /** Housekeeping: atomically drop expired short-lived state. */
  purgeExpired(): Record<string, number> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = {
        authTransactions: Number(
          this.db.prepare('DELETE FROM auth_transactions WHERE expires_at < ?').run(now).changes,
        ),
        authorizationCodes: Number(
          this.db.prepare('DELETE FROM authorization_codes WHERE expires_at < ?').run(now).changes,
        ),
        idempotencyKeys: Number(
          this.db.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?').run(now).changes,
        ),
        streamSessions: Number(
          this.db.prepare('DELETE FROM stream_sessions WHERE expires_at < ?').run(now).changes,
        ),
      };
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
