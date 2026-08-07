/**
 * Persistence and lifecycle for camera connections.
 *
 * Two responsibilities that are easy to conflate and must not be: this owns
 * *configuration* (what the operator declared) and *health* (what a probe
 * observed). They live in separate tables because one is authored and durable
 * while the other is derived and disposable — wiping health must never risk a
 * credential.
 *
 * Provider instances are cached per connection so a Frigate client's keep-alive
 * pool is not rebuilt on every camera-wall refresh, and are invalidated on any
 * write so an edited connection takes effect immediately rather than at the
 * next restart.
 */
import type { Db } from '../../db/index.ts';
import { AppError } from '../../lib/errors.ts';
import { randomId } from '../../lib/crypto.ts';
import type { SecretsCipher } from '../../lib/secrets.ts';
import { SecretsCipherError } from '../../lib/secrets.ts';
import type { ActiveConnection } from './aggregate.ts';
import type { CameraProvider, ProviderRegistry } from './provider.ts';
import { slugify } from './provider.ts';

export interface ConnectionRecord {
  id: string;
  provider: string;
  name: string;
  slug: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  /** Key presence only — values never leave this module. */
  secretsSet: Record<string, boolean>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface ConnectionHealthRecord {
  status: 'healthy' | 'degraded' | 'unreachable' | 'unknown';
  message: string | null;
  cameraCount: number | null;
  latencyMs: number | null;
  checkedAt: string;
}

export interface CreateConnectionInput {
  provider: string;
  name: string;
  settings?: Record<string, unknown>;
  secrets?: Record<string, string>;
  enabled?: boolean;
  sortOrder?: number;
  createdBy?: string | null;
}

export interface UpdateConnectionInput {
  name?: string;
  settings?: Record<string, unknown>;
  /** Only the keys present are changed; omitted secrets keep their value. */
  secrets?: Record<string, string>;
  enabled?: boolean;
  sortOrder?: number;
}

interface Row {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  settings_json: string;
  secrets_json: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export class ConnectionStore {
  readonly #db: Db;
  readonly #registry: ProviderRegistry;
  readonly #cipher: SecretsCipher;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  /** Keyed by connection id + updatedAt, so an edit invalidates naturally. */
  readonly #instances = new Map<string, { key: string; provider: CameraProvider }>();

  constructor(
    db: Db,
    registry: ProviderRegistry,
    cipher: SecretsCipher,
    fetchImpl: typeof fetch,
    timeoutMs = 10_000,
  ) {
    this.#db = db;
    this.#registry = registry;
    this.#cipher = cipher;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  // MARK: Reads

  list(): ConnectionRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM connections ORDER BY sort_order ASC, name ASC')
      .all() as unknown as Row[];
    return rows.map((r) => this.#toRecord(r));
  }

  get(id: string): ConnectionRecord {
    const row = this.#db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
      | unknown as Row
      | undefined;
    if (!row) throw AppError.notFound('Connection');
    return this.#toRecord(row);
  }

  health(id: string): ConnectionHealthRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM connection_health WHERE connection_id = ?')
      .get(id) as unknown as
      | {
          status: string;
          message: string | null;
          camera_count: number | null;
          latency_ms: number | null;
          checked_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      status: row.status as ConnectionHealthRecord['status'],
      message: row.message,
      cameraCount: row.camera_count,
      latencyMs: row.latency_ms,
      checkedAt: row.checked_at,
    };
  }

  // MARK: Writes

  create(input: CreateConnectionInput): ConnectionRecord {
    if (!this.#registry.has(input.provider)) {
      throw new AppError('VALIDATION_FAILED', `Unknown provider "${input.provider}".`);
    }
    const name = input.name.trim();
    if (!name) throw new AppError('VALIDATION_FAILED', 'A connection needs a name.');
    // The slug namespaces every camera ID this connection contributes, so a
    // name that slugifies to nothing would produce unroutable IDs.
    if (!slugify(name)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The name must contain at least one letter or number.',
      );
    }
    this.#assertNameFree(name, null);
    this.#validateRequiredFields(input.provider, input.settings ?? {}, input.secrets ?? {});

    const now = new Date().toISOString();
    const id = randomId('conn');
    this.#db
      .prepare(
        `INSERT INTO connections
           (id, provider, name, enabled, settings_json, secrets_json, sort_order, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.provider,
        name,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.settings ?? {}),
        JSON.stringify(this.#cipher.encryptRecord(input.secrets ?? {})),
        input.sortOrder ?? 100,
        now,
        now,
        input.createdBy ?? null,
      );
    return this.get(id);
  }

  update(id: string, input: UpdateConnectionInput): ConnectionRecord {
    const existing = this.get(id);
    const name = input.name?.trim() ?? existing.name;
    if (!name) throw new AppError('VALIDATION_FAILED', 'A connection needs a name.');
    if (name !== existing.name) this.#assertNameFree(name, id);

    // Secrets merge rather than replace: the API never returns stored values,
    // so a client editing a URL cannot round-trip the password back and would
    // otherwise blank it.
    const storedSecrets = this.#rawSecrets(id);
    const mergedSecrets = { ...storedSecrets };
    for (const [k, v] of Object.entries(input.secrets ?? {})) {
      if (v === '') delete mergedSecrets[k];
      else mergedSecrets[k] = this.#cipher.encrypt(v);
    }

    const settings = input.settings ?? existing.settings;
    this.#validateRequiredFields(existing.provider, settings, mergedSecrets);

    this.#db
      .prepare(
        `UPDATE connections
            SET name = ?, enabled = ?, settings_json = ?, secrets_json = ?, sort_order = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        name,
        (input.enabled ?? existing.enabled) ? 1 : 0,
        JSON.stringify(settings),
        JSON.stringify(mergedSecrets),
        input.sortOrder ?? existing.sortOrder,
        new Date().toISOString(),
        id,
      );
    this.#instances.delete(id);
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id); // 404 rather than a silent no-op.
    this.#db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    this.#instances.delete(id);
  }

  recordHealth(id: string, health: ConnectionHealthRecord): void {
    this.#db
      .prepare(
        `INSERT INTO connection_health (connection_id, status, message, camera_count, latency_ms, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET
           status = excluded.status, message = excluded.message,
           camera_count = excluded.camera_count, latency_ms = excluded.latency_ms,
           checked_at = excluded.checked_at`,
      )
      .run(id, health.status, health.message, health.cameraCount, health.latencyMs, health.checkedAt);
  }

  // MARK: Provider instances

  /** Enabled connections, instantiated. Feeds the aggregator's thunk. */
  active(): ActiveConnection[] {
    const out: ActiveConnection[] = [];
    for (const record of this.list()) {
      if (!record.enabled) continue;
      try {
        out.push({
          id: record.id,
          slug: record.slug,
          name: record.name,
          provider: this.instance(record.id),
        });
      } catch (error) {
        // A connection whose credentials cannot be decrypted — usually a
        // rotated key — must not take down every other source. It is skipped
        // and its health row explains why.
        this.recordHealth(record.id, {
          status: 'unreachable',
          message:
            error instanceof SecretsCipherError
              ? error.message
              : 'The connection could not be initialised.',
          cameraCount: null,
          latencyMs: null,
          checkedAt: new Date().toISOString(),
        });
      }
    }
    return out;
  }

  instance(id: string): CameraProvider {
    const record = this.get(id);
    const key = record.updatedAt;
    const cached = this.#instances.get(id);
    if (cached && cached.key === key) return cached.provider;

    const provider = this.#registry.create(record.provider, {
      connectionId: record.id,
      slug: record.slug,
      settings: record.settings,
      secrets: this.#cipher.decryptRecord(this.#rawSecrets(id)),
      fetchImpl: this.#fetchImpl,
      timeoutMs: this.#timeoutMs,
    });
    this.#instances.set(id, { key, provider });
    return provider;
  }

  /** Probes one connection and stores the result. Never throws. */
  async probe(id: string): Promise<ConnectionHealthRecord> {
    const now = new Date().toISOString();
    let health: ConnectionHealthRecord;
    try {
      const result = await this.instance(id).probe();
      health = {
        status: result.ok ? 'healthy' : 'unreachable',
        message: result.message,
        cameraCount: result.cameraCount,
        latencyMs: result.latencyMs,
        checkedAt: now,
      };
    } catch (error) {
      health = {
        status: 'unreachable',
        message: error instanceof Error ? error.message : 'The probe failed.',
        cameraCount: null,
        latencyMs: null,
        checkedAt: now,
      };
    }
    this.recordHealth(id, health);
    return health;
  }

  // MARK: Internals

  #toRecord(row: Row): ConnectionRecord {
    const secrets = JSON.parse(row.secrets_json) as Record<string, string>;
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      slug: slugify(row.name),
      enabled: row.enabled === 1,
      settings: JSON.parse(row.settings_json) as Record<string, unknown>,
      secretsSet: Object.fromEntries(Object.keys(secrets).map((k) => [k, true])),
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
    };
  }

  #rawSecrets(id: string): Record<string, string> {
    const row = this.#db.prepare('SELECT secrets_json FROM connections WHERE id = ?').get(id) as
      | unknown as { secrets_json: string }
      | undefined;
    return row ? (JSON.parse(row.secrets_json) as Record<string, string>) : {};
  }

  /**
   * Names must stay unique *after* slugification, not just as typed: "Front
   * Door" and "front-door" both become `front-door` and would silently make one
   * connection's cameras unreachable.
   */
  #assertNameFree(name: string, exceptId: string | null): void {
    const slug = slugify(name);
    const clash = this.list().find((c) => c.slug === slug && c.id !== exceptId);
    if (clash) {
      throw new AppError(
        'CONFLICT',
        `"${clash.name}" already uses the identifier "${slug}". Pick a more distinct name.`,
      );
    }
  }

  #validateRequiredFields(
    providerId: string,
    settings: Record<string, unknown>,
    secrets: Record<string, string>,
  ): void {
    const descriptor = this.#registry.descriptor(providerId);
    if (!descriptor) return;
    const missing = descriptor.fields
      .filter((f) => f.required)
      .filter((f) => {
        const value = f.type === 'secret' ? secrets[f.key] : settings[f.key];
        return value === undefined || value === null || value === '';
      })
      .map((f) => f.label);
    if (missing.length > 0) {
      throw new AppError('VALIDATION_FAILED', `Missing required settings: ${missing.join(', ')}.`);
    }
  }
}
