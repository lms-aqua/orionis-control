/**
 * APNs device registration, preferences and delivery.
 *
 * Delivery uses APNs' HTTP/2 JSON API with a JWT provider token. When APNs is
 * not configured, registration still works and `send` reports
 * PUSH_NOT_CONFIGURED — notifications are never silently swallowed.
 *
 * Payloads carry only what the app needs to route the user to the right screen.
 * No camera imagery, no domains, no clip URLs, no identity detail.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import type { Db } from '../db/index.ts';
import type { Config } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import { hashToken, randomId } from '../lib/crypto.ts';

export const NOTIFICATION_KINDS = [
  'camera.offline',
  'camera.restored',
  'event.motion',
  'event.person',
  'event.vehicle',
  'event.package',
  'recording.failure',
  'storage.warning',
  'adguard.disabled',
  'adguard.enabled',
  'dns.failure',
  'orionis.failure',
  'infrastructure.critical',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface QuietHours {
  enabled: boolean;
  /** Local minutes from midnight. */
  startMinute: number;
  endMinute: number;
}

export interface NotificationPreferences {
  enabled: boolean;
  kinds: Record<string, boolean>;
  cameras: Record<string, boolean>;
  minimumSeverity: 'info' | 'warning' | 'critical';
  quietHours: QuietHours;
  criticalBypassesQuietHours: boolean;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  kinds: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])),
  cameras: {},
  minimumSeverity: 'info',
  quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 7 * 60 },
  criticalBypassesQuietHours: true,
};

export interface PushMessage {
  kind: NotificationKind;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  /** Deep-link target, e.g. orioniscontrol://camera/front-door */
  deepLink: string;
  cameraId?: string;
  eventId?: string;
}

/** Runs asynchronous work in fixed-size waves so one fan-out cannot flood an upstream. */
export async function mapInBatches<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  const results: R[] = [];
  for (let index = 0; index < values.length; index += concurrency) {
    results.push(...(await Promise.all(values.slice(index, index + concurrency).map(operation))));
  }
  return results;
}

/**
 * Decides whether a message should be delivered, given preferences and time.
 * Pure — unit tested directly.
 */
export function shouldDeliver(
  prefs: NotificationPreferences,
  message: PushMessage,
  localMinuteOfDay: number,
): { deliver: boolean; reason: string } {
  if (!prefs.enabled) return { deliver: false, reason: 'notifications_disabled' };
  if (prefs.kinds[message.kind] === false) return { deliver: false, reason: 'kind_muted' };

  if (message.cameraId && prefs.cameras[message.cameraId] === false) {
    return { deliver: false, reason: 'camera_muted' };
  }

  const rank = { info: 0, warning: 1, critical: 2 };
  if (rank[message.severity] < rank[prefs.minimumSeverity]) {
    return { deliver: false, reason: 'below_minimum_severity' };
  }

  if (prefs.quietHours.enabled) {
    const { startMinute, endMinute } = prefs.quietHours;
    const inQuiet =
      startMinute <= endMinute
        ? localMinuteOfDay >= startMinute && localMinuteOfDay < endMinute
        : localMinuteOfDay >= startMinute || localMinuteOfDay < endMinute;
    if (inQuiet && !(message.severity === 'critical' && prefs.criticalBypassesQuietHours)) {
      return { deliver: false, reason: 'quiet_hours' };
    }
  }

  return { deliver: true, reason: 'ok' };
}

export class PushService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  get configured(): boolean {
    return this.config.apns.configured;
  }

  // Device tokens are stored encrypted at rest: they are addressable secrets.
  private cipherKey(): Buffer {
    return createHash('sha256').update(this.config.sessionSigningKey).digest();
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cipherKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      enc.toString('base64'),
    ].join('.');
  }

  private decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64)
      throw new AppError('INTERNAL_ERROR', 'Stored device token is unreadable.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.cipherKey(),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  registerDevice(input: {
    userId: string;
    sessionId: string;
    deviceId: string;
    token: string;
    environment: 'sandbox' | 'production';
  }): { id: string; pushConfigured: boolean } {
    if (!/^[a-f0-9]{64,200}$/i.test(input.token)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The APNs device token is not a valid hexadecimal token.',
      );
    }
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT id FROM push_devices WHERE user_id = ? AND device_id = ?')
      .get(input.userId, input.deviceId) as { id: string } | undefined;

    const id = existing?.id ?? randomId('pdv');
    if (existing) {
      this.db
        .prepare(
          `UPDATE push_devices SET session_id = ?, token_hash = ?, token_cipher = ?,
             environment = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.sessionId,
          hashToken(input.token),
          this.encrypt(input.token),
          input.environment,
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO push_devices (id, user_id, session_id, device_id, token_hash, token_cipher,
             environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          input.sessionId,
          input.deviceId,
          hashToken(input.token),
          this.encrypt(input.token),
          input.environment,
          now,
          now,
        );
    }
    return { id, pushConfigured: this.configured };
  }

  removeDevice(userId: string, deviceId: string): boolean {
    const before = this.db
      .prepare('SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ? AND device_id = ?')
      .get(userId, deviceId) as { n: number };
    this.db
      .prepare('DELETE FROM push_devices WHERE user_id = ? AND device_id = ?')
      .run(userId, deviceId);
    return before.n > 0;
  }

  getPreferences(userId: string, deviceId: string): NotificationPreferences {
    const row = this.db
      .prepare(
        'SELECT prefs_json FROM notification_preferences WHERE user_id = ? AND device_id = ?',
      )
      .get(userId, deviceId) as { prefs_json: string } | undefined;
    if (!row) return structuredClone(DEFAULT_PREFERENCES);
    try {
      return { ...structuredClone(DEFAULT_PREFERENCES), ...(JSON.parse(row.prefs_json) as object) };
    } catch {
      return structuredClone(DEFAULT_PREFERENCES);
    }
  }

  setPreferences(userId: string, deviceId: string, prefs: NotificationPreferences): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO notification_preferences (user_id, device_id, prefs_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET prefs_json = excluded.prefs_json,
           updated_at = excluded.updated_at`,
      )
      .run(userId, deviceId, JSON.stringify(prefs), now);
  }

  /** Builds the APNs provider JWT (valid up to 1 hour; APNs requires >20min reuse). */
  private async providerToken(): Promise<string> {
    const key = await importPKCS8(this.config.apns.privateKey, 'ES256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.apns.keyId })
      .setIssuer(this.config.apns.teamId)
      .setIssuedAt()
      .sign(key);
  }

  /**
   * Sends one notification. Returns a per-device result rather than throwing,
   * so a single dead token cannot fail a fan-out.
   */
  async send(
    userId: string,
    message: PushMessage,
    now = new Date(),
  ): Promise<{ attempted: number; delivered: number; skipped: string[]; configured: boolean }> {
    const devices = this.db
      .prepare('SELECT * FROM push_devices WHERE user_id = ?')
      .all(userId) as Record<string, unknown>[];

    if (!this.configured) {
      return {
        attempted: devices.length,
        delivered: 0,
        skipped: ['PUSH_NOT_CONFIGURED'],
        configured: false,
      };
    }

    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    let delivered = 0;
    const skipped: string[] = [];
    const token = await this.providerToken();

    const sendOne = async (
      device: Record<string, unknown>,
    ): Promise<{ delivered: boolean; skipped?: string }> => {
      const deviceId = String(device.device_id);
      const prefs = this.getPreferences(userId, deviceId);
      const decision = shouldDeliver(prefs, message, minuteOfDay);
      if (!decision.deliver) {
        return { delivered: false, skipped: decision.reason };
      }

      const host =
        String(device.environment) === 'production'
          ? 'https://api.push.apple.com'
          : 'https://api.sandbox.push.apple.com';

      // Deliberately minimal payload — no imagery, no domain, no PII.
      const payload = {
        aps: {
          alert: { title: message.title, body: message.body },
          sound: message.severity === 'critical' ? 'default' : undefined,
          'interruption-level': message.severity === 'critical' ? 'time-sensitive' : 'active',
          'thread-id': message.kind,
        },
        k: message.kind,
        l: message.deepLink,
      };

      try {
        const res = await fetch(`${host}/3/device/${this.decrypt(String(device.token_cipher))}`, {
          method: 'POST',
          headers: {
            authorization: `bearer ${token}`,
            'apns-topic': this.config.apns.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': message.severity === 'info' ? '5' : '10',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          return { delivered: true };
        }
        if (res.status === 410) {
          // Token no longer valid — drop it.
          this.db.prepare('DELETE FROM push_devices WHERE id = ?').run(String(device.id));
          return { delivered: false, skipped: 'token_expired' };
        }
        return { delivered: false, skipped: `apns_${res.status}` };
      } catch {
        return { delivered: false, skipped: 'apns_unreachable' };
      }
    };

    // Four-wide batches bound APNs pressure while ensuring one unreachable
    // handset cannot serially delay every other device for eight seconds.
    const results = await mapInBatches(devices, 4, sendOne);
    for (const result of results) {
      if (result.delivered) delivered += 1;
      else if (result.skipped) skipped.push(result.skipped);
    }

    return { attempted: devices.length, delivered, skipped, configured: true };
  }
}
