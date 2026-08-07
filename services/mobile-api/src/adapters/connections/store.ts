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
import { redactSecrets, SecretsCipherError } from '../../lib/secrets.ts';
import { assertSafeSettings } from '../../lib/upstream-url.ts';
import type { ActiveConnection } from './aggregate.ts';
import type {
  AuthResult,
  CameraProvider,
  ProviderDescriptor,
  ProviderRegistry,
} from './provider.ts';
import { slugify, supportsInteractiveAuth } from './provider.ts';

export interface ConnectionRecord {
  id: string;
  provider: string;
  name: string;
  /** Stable ID prefix, assigned at creation and never changed. */
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
  slug: string;
  enabled: number;
  settings_json: string;
  secrets_json: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** How long a pinned sign-in instance survives without progress. */
const CHALLENGE_TTL_MS = 10 * 60_000;

export class ConnectionStore {
  readonly #db: Db;
  readonly #registry: ProviderRegistry;
  readonly #cipher: SecretsCipher;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  readonly #probeTtlMs: number;
  /** Keyed by connection id + updatedAt, so an edit invalidates naturally. */
  readonly #instances = new Map<string, { key: string; provider: CameraProvider }>();
  /**
   * Instances pinned for the duration of an interactive sign-in.
   *
   * A two-step login holds partial state (Blink: account id, client id, region,
   * the pre-verification token) on the provider object. The normal cache is
   * keyed by `updatedAt`, so *any* write between the two steps would discard
   * that state and the second step would fail with no way for the user to tell
   * why. Pinning here keeps the same object alive across both calls regardless
   * of edits, and it is dropped as soon as the flow ends or the window lapses.
   */
  readonly #challenges = new Map<string, { provider: CameraProvider; expiresAt: number }>();

  constructor(
    db: Db,
    registry: ProviderRegistry,
    cipher: SecretsCipher,
    fetchImpl: typeof fetch,
    timeoutMs = 10_000,
    probeTtlMs = 60_000,
  ) {
    this.#db = db;
    this.#registry = registry;
    this.#cipher = cipher;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#probeTtlMs = probeTtlMs;
  }

  // MARK: Reads

  /**
   * What can be added, and what each kind needs to be told.
   *
   * The app builds its "add connection" form from this rather than shipping a
   * hard-coded form per provider, so a provider added here appears in the app
   * without an app release.
   */
  providers(): ProviderDescriptor[] {
    return this.#registry.descriptors();
  }

  list(): ConnectionRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM connections ORDER BY sort_order ASC, name ASC')
      .all() as unknown as Row[];
    return rows.map((r) => this.#toRecord(r));
  }

  get(id: string): ConnectionRecord {
    const row = this.#db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as unknown as
      | Row
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
    const slug = slugify(name);
    if (!slug) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The name must contain at least one letter or number.',
      );
    }
    this.#assertNameFree(name, null);
    this.#assertSlugFree(slug);
    const settings = input.settings ?? {};
    this.#validateRequiredFields(input.provider, settings, input.secrets ?? {});
    this.#validateUpstreamUrls(input.provider, settings);

    const now = new Date().toISOString();
    const id = randomId('conn');
    this.#db
      .prepare(
        `INSERT INTO connections
           (id, provider, name, slug, enabled, settings_json, secrets_json, sort_order, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.provider,
        name,
        slug,
        input.enabled === false ? 0 : 1,
        JSON.stringify(settings),
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
    // The slug is deliberately *not* recomputed. It is baked into every camera
    // ID this connection has already handed out, and into whatever the app
    // saved as a favourite; renaming must stay a cosmetic change.

    // Secrets merge rather than replace: the API never returns stored values,
    // so a client editing a URL cannot round-trip the credential back and would
    // otherwise blank it.
    const storedSecrets = this.#rawSecrets(id);
    const mergedSecrets = { ...storedSecrets };
    for (const [k, v] of Object.entries(input.secrets ?? {})) {
      if (v === '') delete mergedSecrets[k];
      else mergedSecrets[k] = this.#cipher.encrypt(v);
    }

    const settings = input.settings ?? existing.settings;
    this.#validateRequiredFields(existing.provider, settings, mergedSecrets);
    this.#validateUpstreamUrls(existing.provider, settings);

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
    this.#challenges.delete(id);
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

  /**
   * Re-encrypts every stored credential under the current primary key.
   *
   * Run after rotating `CONNECTIONS_SECRET_KEY` (with the old value still set as
   * `CONNECTIONS_SECRET_KEY_PREVIOUS`). Returns how many connections changed.
   * `updated_at` is left alone: this is a storage detail, not an edit anyone
   * made, and bumping it would invalidate live provider instances for nothing.
   */
  rewrapSecrets(): { rewrapped: number; failed: string[] } {
    const rows = this.#db
      .prepare('SELECT id, secrets_json FROM connections')
      .all() as unknown as { id: string; secrets_json: string }[];
    let rewrapped = 0;
    const failed: string[] = [];

    for (const row of rows) {
      const stored = JSON.parse(row.secrets_json) as Record<string, string>;
      const entries = Object.entries(stored);
      if (entries.length === 0) continue;
      try {
        if (!entries.some(([, v]) => this.#cipher.needsRewrap(v))) continue;
        const next = Object.fromEntries(entries.map(([k, v]) => [k, this.#cipher.rewrap(v)]));
        this.#db
          .prepare('UPDATE connections SET secrets_json = ? WHERE id = ?')
          .run(JSON.stringify(next), row.id);
        this.#instances.delete(row.id);
        rewrapped += 1;
      } catch {
        // Unreadable under every configured key. Naming it is the useful
        // outcome; guessing at recovery is not.
        failed.push(row.id);
      }
    }
    return { rewrapped, failed };
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
          sortOrder: record.sortOrder,
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

  /**
   * The stored health, re-probing only when it has gone stale.
   *
   * Health is read on every system-health poll and on every Connections screen
   * refresh; probing live each time would put one upstream round trip per
   * source behind an operation that is meant to be cheap.
   */
  async healthCached(id: string): Promise<ConnectionHealthRecord> {
    const stored = this.health(id);
    if (stored && Date.now() - Date.parse(stored.checkedAt) < this.#probeTtlMs) {
      return stored;
    }
    return this.probe(id);
  }

  // MARK: Interactive sign-in

  /**
   * Starts a sign-in for a provider that needs one.
   *
   * Credentials are persisted only once the upstream says the flow is complete,
   * so an abandoned or failed attempt leaves nothing half-written.
   */
  async beginAuth(id: string): Promise<AuthResult> {
    const provider = this.#pinnedInstance(id);
    if (!supportsInteractiveAuth(provider)) {
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        'This connection type does not sign in interactively.',
      );
    }
    const result = await provider.beginAuth();
    if (result.status === 'complete') {
      this.#persistObtained(id, provider);
      this.#challenges.delete(id);
    } else if (result.status === 'failed') {
      this.#challenges.delete(id);
    }
    return result;
  }

  async completeAuth(id: string, challengeId: string, code: string): Promise<AuthResult> {
    const provider = this.#pinnedInstance(id);
    if (!supportsInteractiveAuth(provider)) {
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        'This connection type does not sign in interactively.',
      );
    }
    const result = await provider.completeAuth(challengeId, code);
    if (result.status === 'complete') {
      this.#persistObtained(id, provider);
      this.#challenges.delete(id);
    }
    return result;
  }

  /** The instance serving a sign-in, kept alive across both of its steps. */
  #pinnedInstance(id: string): CameraProvider {
    const now = Date.now();
    for (const [key, pinned] of this.#challenges) {
      if (pinned.expiresAt <= now) this.#challenges.delete(key);
    }
    const existing = this.#challenges.get(id);
    if (existing) {
      existing.expiresAt = now + CHALLENGE_TTL_MS;
      return existing.provider;
    }
    const provider = this.instance(id);
    this.#challenges.set(id, { provider, expiresAt: now + CHALLENGE_TTL_MS });
    return provider;
  }

  /** Writes what a completed sign-in produced. The store is the only writer. */
  #persistObtained(id: string, provider: CameraProvider): void {
    if (!supportsInteractiveAuth(provider)) return;
    const secrets = provider.pendingSecrets();
    const settings = provider.pendingSettings();
    if (Object.keys(secrets).length === 0 && Object.keys(settings).length === 0) return;

    const record = this.get(id);
    const mergedSecrets = { ...this.#rawSecrets(id), ...this.#cipher.encryptRecord(secrets) };
    const mergedSettings = { ...record.settings, ...settings };
    this.#db
      .prepare('UPDATE connections SET secrets_json = ?, settings_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(mergedSecrets), JSON.stringify(mergedSettings), new Date().toISOString(), id);
    this.#instances.delete(id);
  }

  // MARK: Internals

  #toRecord(row: Row): ConnectionRecord {
    const secrets = JSON.parse(row.secrets_json) as Record<string, string>;
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      // Rows written before the slug column existed were backfilled by the
      // migration; falling back to the old derivation keeps a hand-edited or
      // partially migrated row addressable rather than unroutable.
      slug: row.slug || slugify(row.name),
      enabled: row.enabled === 1,
      settings: JSON.parse(row.settings_json) as Record<string, unknown>,
      secretsSet: redactSecrets(secrets),
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

  #assertNameFree(name: string, exceptId: string | null): void {
    const clash = this.list().find(
      (c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== exceptId,
    );
    if (clash) {
      throw new AppError('CONFLICT', `A connection named "${clash.name}" already exists.`);
    }
  }

  /**
   * Slugs must be unique *after* slugification: "Front Door" and "front-door"
   * both become `front-door`, and two connections sharing an ID prefix would
   * make one of them silently unreachable.
   */
  #assertSlugFree(slug: string): void {
    const clash = this.list().find((c) => c.slug === slug);
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

  /**
   * Every URL the gateway will later fetch is checked before it is stored, so a
   * dangerous address is refused at the point someone types it rather than
   * discovered when a probe reaches it.
   */
  #validateUpstreamUrls(providerId: string, settings: Record<string, unknown>): void {
    const descriptor = this.#registry.descriptor(providerId);
    if (!descriptor) return;
    assertSafeSettings(descriptor.fields, settings);
  }
}
