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
import { randomId, randomToken } from '../../lib/crypto.ts';
import type { ProvisioningRequest } from '../../lib/provisioning.ts';
import { ProvisioningDirectory } from '../../lib/provisioning.ts';
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
import type { ProvisioningRecord } from './provisioning.ts';
import { acceptProvidedSettings, ProvisioningTable, resolveHandover } from './provisioning.ts';

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
  /** The shared directory a host-side applier watches. Disabled when unset. */
  readonly #provisioningDir: ProvisioningDirectory;
  readonly #provisioning: ProvisioningTable;
  /** Ceiling on bridge instances, so a loop cannot fill the host with them. */
  readonly #maxInstances: number;

  constructor(
    db: Db,
    registry: ProviderRegistry,
    cipher: SecretsCipher,
    fetchImpl: typeof fetch,
    timeoutMs = 10_000,
    probeTtlMs = 60_000,
    provisioningDir: ProvisioningDirectory = new ProvisioningDirectory(''),
    maxInstances = 8,
  ) {
    this.#db = db;
    this.#registry = registry;
    this.#cipher = cipher;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#probeTtlMs = probeTtlMs;
    this.#provisioningDir = provisioningDir;
    this.#provisioning = new ProvisioningTable(db);
    this.#maxInstances = maxInstances;
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
      Row | undefined;
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
      .run(
        id,
        health.status,
        health.message,
        health.cameraCount,
        health.latencyMs,
        health.checkedAt,
      );
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
    const rows = this.#db.prepare('SELECT id, secrets_json FROM connections').all() as unknown as {
      id: string;
      secrets_json: string;
    }[];
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
  async beginAuth(id: string, actor: string | null = null): Promise<AuthResult> {
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
      await this.#reseedBridge(id, actor);
    } else if (result.status === 'failed') {
      this.#challenges.delete(id);
    }
    return result;
  }

  async completeAuth(
    id: string,
    challengeId: string,
    code: string,
    actor: string | null = null,
  ): Promise<AuthResult> {
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
      // The moment there is a session worth having, the bridge is given it —
      // rather than leaving it to introduce itself to Blink on its own and be
      // sent a code nobody will see.
      await this.#reseedBridge(id, actor);
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
      .prepare(
        'UPDATE connections SET secrets_json = ?, settings_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        JSON.stringify(mergedSecrets),
        JSON.stringify(mergedSettings),
        new Date().toISOString(),
        id,
      );
    this.#instances.delete(id);
  }

  // MARK: Bridge provisioning
  //
  // Some providers need a helper service running beside the gateway before they
  // can do anything — Blink needs a lostblink and a MediaMTX, Wyze needs
  // docker-wyze-bridge. The gateway asks for one by writing a file naming a
  // vetted template; a privileged host-side unit does the work and reports back.
  // Nothing here touches Docker, and nothing here chooses what runs.

  /** Whether this deployment can stand a bridge up at all. */
  get provisioningAvailable(): boolean {
    return this.#provisioningDir.available;
  }

  /** The last known state, without asking the filesystem. */
  provisioning(id: string): ProvisioningRecord | null {
    return this.#provisioning.get(id);
  }

  /**
   * The current state, after reading whatever the applier has said since.
   *
   * Reconciliation happens on read rather than on a timer because the only
   * moment the answer matters is when someone is looking at it — and a poll
   * would keep a background handle on a shared directory for the 99% of the
   * time no bridge is being created.
   */
  async provisioningState(id: string): Promise<ProvisioningRecord | null> {
    const record = this.#provisioning.get(id);
    if (!record) return null;

    const status = await this.#provisioningDir.readStatus(id);
    // An answer to a *different* request is a leftover from a previous instance
    // for this connection. Believing it would report a container that has
    // already been torn down as ready.
    if (!status || status.id !== record.requestId) {
      if (record.state === 'pending' && !(await this.#provisioningDir.hasPendingRequest(id))) {
        // The request is gone and no answer replaced it: the applier consumed
        // it and is working, or it crashed mid-way. "Setting up" is the honest
        // reading; a later status file settles it either way.
        this.#provisioning.advance(id, 'provisioning', 'The host has picked this up.');
        return this.#provisioning.get(id);
      }
      return record;
    }

    if (status.state === record.state && (status.message ?? null) === record.message) {
      return record;
    }
    // Already judged failed for this exact request. Re-reading the same status
    // would re-run the same rejected apply and answer 400 forever; a retry
    // writes a fresh request id, which is what lets this move again.
    if (record.state === 'failed') return record;

    if (status.state === 'ready') {
      try {
        this.#applyProvisioned(id, status.settings);
      } catch (error) {
        // The applier reported an address this gateway will not fetch. That is
        // a failed setup, not a failed *request* — recording it as such is what
        // stops the app polling a route that will refuse identically forever,
        // and puts the reason on the screen instead of in a 400 nobody reads.
        this.#provisioning.advance(
          id,
          'failed',
          error instanceof Error
            ? `The bridge started, but reported an address this gateway will not use: ${error.message}`
            : 'The bridge reported an address this gateway will not use.',
        );
        throw error;
      }
    }
    if (status.state === 'removed') {
      // The instance is gone; forget the conversation so the connection can be
      // provisioned again cleanly rather than inheriting a dead answer.
      this.#provisioning.remove(id);
      await this.#provisioningDir.forget(id);
      return null;
    }

    this.#provisioning.advance(id, status.state, status.message || null);
    return this.#provisioning.get(id);
  }

  /**
   * Asks for a bridge for this connection.
   *
   * Everything the request can contain is decided here from the provider's own
   * declaration: the template name, the instance name (this connection's slug,
   * already validated and unique), and the specific values the descriptor said
   * the instance needs. The caller supplies none of it, so there is no field an
   * app can put an image name or a volume path into.
   */
  async requestProvisioning(id: string, actor: string | null): Promise<ProvisioningRecord> {
    const record = this.get(id);
    const bridge = this.#registry.descriptor(record.provider)?.bridge;
    if (!bridge) {
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        'This kind of source does not need anything set up — point it at the system you already run.',
      );
    }
    if (!this.#provisioningDir.available) {
      throw new AppError(
        'SERVICE_NOT_CONFIGURED',
        'This gateway cannot set up bridges: no provisioning directory is configured. Start one yourself and enter its address instead.',
      );
    }

    // A source that signs in interactively must be signed in before its bridge
    // is created. Otherwise the bridge is handed only the raw email and password
    // and logs in from scratch — which mails the user a verification code at a
    // console nobody is watching, on every start. Requiring the verified session
    // first means the code they typed in the app is the only one they ever get.
    const provider = this.instance(id);
    if (supportsInteractiveAuth(provider) && !provider.isSignedIn()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Finish signing in to this source before setting it up, so its bridge is handed the verified session instead of asking for a new verification code.',
      );
    }

    const existing = this.#provisioning.get(id);
    if (existing && existing.state !== 'failed') {
      // Idempotent by intent: asking twice for the same bridge is what an
      // impatient tap produces, and it must not create a second instance.
      return existing;
    }

    if (!existing && (await this.#provisioningDir.instanceCount()) >= this.#maxInstances) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This gateway is already running ${this.#maxInstances} bridges, which is its limit. Remove one before adding another.`,
      );
    }

    return this.#writeCreateRequest(id, actor, 'Waiting for the host to pick this up.');
  }

  /**
   * Re-sends the instance its configuration after a sign-in completed.
   *
   * A bridge is asked for at creation, when the account has been typed but not
   * yet verified — so the first request cannot carry a session that does not
   * exist yet. Without this, lostblink would start with an email and a password,
   * introduce itself to Blink as a stranger, and be mailed a verification code
   * at a console nobody is watching: precisely the failure the in-app code step
   * was built to replace.
   *
   * Silent when there is no bridge, which is every other provider.
   */
  async #reseedBridge(id: string, actor: string | null): Promise<void> {
    if (!this.#provisioning.get(id)) return;
    const bridge = this.#registry.descriptor(this.get(id).provider)?.bridge;
    // Only worth doing for a template that was declared to receive credentials;
    // for anything else the request would be byte-identical to the last one.
    if (!bridge?.handsOver) return;
    try {
      await this.#writeCreateRequest(id, actor, 'Handing the signed-in session to the bridge.');
    } catch {
      // A sign-in that worked must not be reported as failed because a shared
      // directory was briefly unwritable. The bridge keeps whatever it had, and
      // the connection's own session is unaffected.
    }
  }

  /** The one place a create request is built. Both callers share every rule. */
  async #writeCreateRequest(
    id: string,
    actor: string | null,
    message: string,
  ): Promise<ProvisioningRecord> {
    const record = this.get(id);
    // Non-null at both call sites: `requestProvisioning` has already refused a
    // provider without one, and `#reseedBridge` returns early.
    const bridge = this.#registry.descriptor(record.provider)!.bridge!;
    const secrets = this.#cipher.decryptRecord(this.#rawSecrets(id));

    // Minted here so credentials only ever travel outward: the gateway stores
    // the key at the same moment it hands it over, rather than reading it back
    // out of a container later. Only when there is not one already — a reseed
    // must hand the instance the key it is already using, not a new one.
    const minted: Record<string, string> = {};
    for (const key of bridge.mints ?? []) minted[key] = secrets[key] || randomToken(24);
    const freshlyMinted = Object.fromEntries(
      Object.entries(minted).filter(([key]) => !secrets[key]),
    );

    const request: ProvisioningRequest = {
      id: randomId('prov'),
      connectionId: record.id,
      provider: record.provider,
      template: bridge.template,
      action: 'create',
      instance: record.slug,
      requestedAt: new Date().toISOString(),
      requestedBy: actor,
      handover: resolveHandover(bridge, record.settings, secrets, minted),
    };

    await this.#provisioningDir.write(request);

    if (Object.keys(freshlyMinted).length > 0) this.#mergeSecrets(id, freshlyMinted);

    this.#provisioning.upsert({
      connectionId: record.id,
      requestId: request.id,
      template: request.template,
      instance: request.instance,
      state: 'pending',
      message,
      requestedAt: request.requestedAt,
      updatedAt: request.requestedAt,
      requestedBy: actor,
    });
    return this.#provisioning.get(id) as ProvisioningRecord;
  }

  /**
   * Asks for this connection's bridge to be stopped and removed.
   *
   * Volumes are never named in a teardown request and the templates keep their
   * data in named volumes deliberately: removing a source should not silently
   * destroy whatever it recorded. Reclaiming disk stays a decision someone makes
   * on the host, with the whole picture in front of them.
   */
  async requestTeardown(id: string, actor: string | null): Promise<ProvisioningRecord | null> {
    const existing = this.#provisioning.get(id);
    if (!existing || !this.#provisioningDir.available) return null;

    const request: ProvisioningRequest = {
      id: randomId('prov'),
      connectionId: id,
      provider: this.get(id).provider,
      template: existing.template,
      action: 'remove',
      instance: existing.instance,
      requestedAt: new Date().toISOString(),
      requestedBy: actor,
    };
    await this.#provisioningDir.write(request);

    this.#provisioning.upsert({
      ...existing,
      requestId: request.id,
      state: 'removing',
      message: 'Waiting for the host to stop this bridge.',
      updatedAt: request.requestedAt,
      requestedBy: actor,
    });
    return this.#provisioning.get(id);
  }

  /** Writes the addresses the applier resolved onto the connection. */
  #applyProvisioned(id: string, reported: Record<string, string> | undefined): void {
    const record = this.get(id);
    const bridge = this.#registry.descriptor(record.provider)?.bridge;
    if (!bridge) return;

    const accepted = acceptProvidedSettings(bridge, reported);
    if (Object.keys(accepted).length === 0) return;

    const settings = { ...record.settings, ...accepted };
    // Held to the same standard as a typed one: the applier is trusted to run
    // containers, not to decide what this gateway may fetch.
    this.#validateUpstreamUrls(record.provider, settings);

    this.#db
      .prepare('UPDATE connections SET settings_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(settings), new Date().toISOString(), id);
    this.#instances.delete(id);
  }

  /** Adds secrets without disturbing the ones already stored. */
  #mergeSecrets(id: string, secrets: Record<string, string>): void {
    const merged = { ...this.#rawSecrets(id), ...this.#cipher.encryptRecord(secrets) };
    this.#db
      .prepare('UPDATE connections SET secrets_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), new Date().toISOString(), id);
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
    const row = this.#db
      .prepare('SELECT secrets_json FROM connections WHERE id = ?')
      .get(id) as unknown as { secrets_json: string } | undefined;
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
