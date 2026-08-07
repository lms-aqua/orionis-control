/**
 * The gateway's record of bridges it has asked for.
 *
 * Split from `lib/provisioning.ts` on the same line as everywhere else in this
 * folder: that file owns the wire — the request and status documents shared
 * with the applier — and this one owns the row. Neither knows about the other's
 * failure modes, so a malformed status file cannot corrupt a record and a
 * database error cannot leave a half-written request on disk.
 *
 * The row is never the source of truth about what is running. It records what
 * was asked for and what the applier last said, which is exactly enough to tell
 * an operator "still setting up" instead of showing a connection that looks
 * broken for the ninety seconds an image takes to pull.
 */
import type { Db } from '../../db/index.ts';
import type { ProvisioningState } from '../../lib/provisioning.ts';
import type { ProviderBridge } from './provider.ts';

export interface ProvisioningRecord {
  connectionId: string;
  requestId: string;
  template: string;
  instance: string;
  state: ProvisioningState;
  message: string | null;
  requestedAt: string;
  updatedAt: string;
  requestedBy: string | null;
}

interface Row {
  connection_id: string;
  request_id: string;
  template: string;
  instance: string;
  state: string;
  message: string | null;
  requested_at: string;
  updated_at: string;
  requested_by: string | null;
}

/** States in which nothing is expected to change without the applier acting. */
const SETTLED: ReadonlySet<ProvisioningState> = new Set<ProvisioningState>([
  'ready',
  'failed',
  'removed',
]);

export function isSettled(state: ProvisioningState): boolean {
  return SETTLED.has(state);
}

export class ProvisioningTable {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(connectionId: string): ProvisioningRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM connection_provisioning WHERE connection_id = ?')
      .get(connectionId) as unknown as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** One row per connection: a new request replaces the old conversation. */
  upsert(record: ProvisioningRecord): void {
    this.#db
      .prepare(
        `INSERT INTO connection_provisioning
           (connection_id, request_id, template, instance, state, message, requested_at, updated_at, requested_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET
           request_id = excluded.request_id, template = excluded.template,
           instance = excluded.instance, state = excluded.state,
           message = excluded.message, requested_at = excluded.requested_at,
           updated_at = excluded.updated_at, requested_by = excluded.requested_by`,
      )
      .run(
        record.connectionId,
        record.requestId,
        record.template,
        record.instance,
        record.state,
        record.message,
        record.requestedAt,
        record.updatedAt,
        record.requestedBy,
      );
  }

  advance(connectionId: string, state: ProvisioningState, message: string | null): void {
    this.#db
      .prepare(
        'UPDATE connection_provisioning SET state = ?, message = ?, updated_at = ? WHERE connection_id = ?',
      )
      .run(state, message, new Date().toISOString(), connectionId);
  }

  remove(connectionId: string): void {
    this.#db
      .prepare('DELETE FROM connection_provisioning WHERE connection_id = ?')
      .run(connectionId);
  }
}

function toRecord(row: Row): ProvisioningRecord {
  return {
    connectionId: row.connection_id,
    requestId: row.request_id,
    template: row.template,
    instance: row.instance,
    state: row.state as ProvisioningState,
    message: row.message,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    requestedBy: row.requested_by,
  };
}

/**
 * Assembles exactly what a template was declared to receive, and nothing else.
 *
 * The whitelist lives on the provider descriptor rather than in the applier's
 * head, so "what can leave the gateway" is answered by reading one provider
 * file. A key the descriptor did not name is not sent even if it exists, and a
 * key it named but the connection does not hold is simply absent — the applier
 * decides whether that is fatal for its template.
 */
export function resolveHandover(
  bridge: ProviderBridge,
  settings: Record<string, unknown>,
  secrets: Record<string, string>,
  minted: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of bridge.handsOver?.settings ?? []) {
    const value = settings[key];
    if (value !== undefined && value !== null && value !== '') out[key] = String(value);
  }
  for (const key of bridge.handsOver?.secrets ?? []) {
    const value = secrets[key];
    if (value) out[key] = value;
  }
  for (const key of bridge.mints ?? []) {
    const value = minted[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Only the settings a template said it provides are accepted back.
 *
 * The applier is trusted to run containers, but its status file is still input:
 * without this filter a bad or tampered one could write any key into any
 * connection's settings, including one the provider treats as an address to
 * fetch. Values are strings by contract; anything else is dropped rather than
 * coerced into a plausible-looking address.
 */
export function acceptProvidedSettings(
  bridge: ProviderBridge,
  reported: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!reported) return out;
  for (const key of bridge.provides) {
    const value = reported[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}
