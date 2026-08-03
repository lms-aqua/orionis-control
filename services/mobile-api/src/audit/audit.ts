/**
 * Append-only audit trail.
 *
 * Every state-changing or security-relevant action writes exactly one record.
 * Metadata is redacted before storage, and client IPs are stored only as a
 * keyed hash so the log is useful for correlation without retaining addresses.
 */
import { createHmac } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { randomId } from '../lib/crypto.ts';
import { redact } from '../lib/redact.ts';

export type AuditOutcome = 'success' | 'failure' | 'denied';

export const AUDIT_ACTIONS = [
  'auth.login.started',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.login.denied_no_role',
  'auth.refresh.succeeded',
  'auth.refresh.reuse_detected',
  'auth.logout',
  'auth.session.revoked',
  'camera.control.invoked',
  'camera.restart',
  'camera.stream.session_created',
  'event.acknowledged',
  'recording.played',
  'recording.retention.requested',
  'infra.authelia.restart_requested',
  'infra.authelia.backup_restored',
  'infra.authelia.password_reset',
  'infra.authelia.config_applied',
  'infra.caddy.config_applied',
  'recording.deleted',
  'adguard.protection.disabled',
  'adguard.protection.enabled',
  'adguard.rule.added',
  'adguard.rule.removed',
  'adguard.filter.refreshed',
  'adguard.client.updated',
  'system.action.invoked',
  'device.registered',
  'device.removed',
  'notifications.preferences.updated',
  'client.media.incident_reported',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditActor {
  id: string | null;
  name: string | null;
  role: string | null;
  deviceId: string | null;
}

export interface AuditInput {
  action: AuditAction;
  actor: AuditActor;
  outcome: AuditOutcome;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  deviceId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly ipHashKey: string,
  ) {}

  private hashIp(ip: string | null | undefined): string | null {
    if (!ip) return null;
    return createHmac('sha256', this.ipHashKey).update(ip).digest('hex').slice(0, 32);
  }

  record(input: AuditInput): AuditRecord {
    const id = randomId('aud');
    const occurredAt = new Date().toISOString();
    const metadata = (redact(input.metadata ?? {}) ?? {}) as Record<string, unknown>;

    this.db
      .prepare(
        `INSERT INTO audit_events (id, occurred_at, actor_id, actor_name, actor_role, device_id,
           action, target_type, target_id, outcome, reason, request_id, ip_hash, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        occurredAt,
        input.actor.id,
        input.actor.name,
        input.actor.role,
        input.actor.deviceId,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.outcome,
        input.reason ?? null,
        input.requestId ?? null,
        this.hashIp(input.ip),
        JSON.stringify(metadata),
      );

    return {
      id,
      occurredAt,
      actorId: input.actor.id,
      actorName: input.actor.name,
      actorRole: input.actor.role,
      deviceId: input.actor.deviceId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      outcome: input.outcome,
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
      metadata,
    };
  }

  list(opts: {
    limit: number;
    offset: number;
    action?: string;
    actorId?: string;
    since?: string;
  }): { items: AuditRecord[]; total: number } {
    const where: string[] = [];
    const args: (string | number | null)[] = [];
    if (opts.action) {
      where.push('action = ?');
      args.push(opts.action);
    }
    if (opts.actorId) {
      where.push('actor_id = ?');
      args.push(opts.actorId);
    }
    if (opts.since) {
      where.push('occurred_at >= ?');
      args.push(opts.since);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM audit_events ${clause}`).get(...args) as {
        n: number;
      }
    ).n;

    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${clause} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`)
      .all(...args, opts.limit, opts.offset) as Record<string, unknown>[];

    return {
      total,
      items: rows.map((r) => ({
        id: String(r.id),
        occurredAt: String(r.occurred_at),
        actorId: (r.actor_id as string) ?? null,
        actorName: (r.actor_name as string) ?? null,
        actorRole: (r.actor_role as string) ?? null,
        deviceId: (r.device_id as string) ?? null,
        action: String(r.action),
        targetType: (r.target_type as string) ?? null,
        targetId: (r.target_id as string) ?? null,
        outcome: r.outcome as AuditOutcome,
        reason: (r.reason as string) ?? null,
        requestId: (r.request_id as string) ?? null,
        metadata: JSON.parse(String(r.metadata_json ?? '{}')) as Record<string, unknown>,
      })),
    };
  }
}
