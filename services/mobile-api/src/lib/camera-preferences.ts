/**
 * Which cameras someone has starred, and the order they want them in.
 *
 * Held per account rather than per device: this is a property of the person, not
 * the handset, so a second phone should inherit it rather than start empty.
 *
 * Both lists are reconciled against the cameras that currently exist on every
 * read. A camera that has been removed upstream must not linger in a favourites
 * list forever, and — more importantly — a stored order must never be able to hide
 * a camera that does exist. Anything not in the stored order is appended, so a
 * newly added camera always appears.
 */
import type { Db } from '../db/index.ts';

export interface CameraPreferences {
  favouriteIds: string[];
  /** Every known camera id, in the viewer's preferred order. */
  order: string[];
}

const KEY = 'cameras';

interface Row {
  value_json: string;
}

function readStored(db: Db, userId: string): { favouriteIds: string[]; order: string[] } {
  const row = db
    .prepare('SELECT value_json FROM account_preferences WHERE user_id = ? AND key = ?')
    .get(userId, KEY) as Row | undefined;
  if (!row) return { favouriteIds: [], order: [] };
  try {
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
    const asIds = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return { favouriteIds: asIds(parsed.favouriteIds), order: asIds(parsed.order) };
  } catch {
    // Corrupt JSON is treated as "no preferences" rather than failing the request:
    // a bad row must not make the camera list unreadable.
    return { favouriteIds: [], order: [] };
  }
}

/** Reconciles stored preferences against the cameras that exist right now. */
export function resolveCameraPreferences(
  db: Db,
  userId: string,
  knownCameraIds: string[],
): CameraPreferences {
  const stored = readStored(db, userId);
  const known = new Set(knownCameraIds);

  const favouriteIds = dedupe(stored.favouriteIds).filter((id) => known.has(id));

  // Stored order first (minus anything gone), then every camera it did not
  // mention — so a camera added since the order was saved is still visible.
  const ordered = dedupe(stored.order).filter((id) => known.has(id));
  const remaining = knownCameraIds.filter((id) => !ordered.includes(id));

  return { favouriteIds, order: [...ordered, ...remaining] };
}

export function saveCameraPreferences(
  db: Db,
  userId: string,
  input: { favouriteIds?: string[]; order?: string[] },
  knownCameraIds: string[],
): CameraPreferences {
  const known = new Set(knownCameraIds);
  const existing = readStored(db, userId);

  // An absent field means "leave it alone", so the app can update one list
  // without having to send the other.
  const favouriteIds = dedupe(input.favouriteIds ?? existing.favouriteIds).filter((id) =>
    known.has(id),
  );
  const order = dedupe(input.order ?? existing.order).filter((id) => known.has(id));

  db.prepare(
    `INSERT INTO account_preferences (user_id, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json,
                                             updated_at = excluded.updated_at`,
  ).run(userId, KEY, JSON.stringify({ favouriteIds, order }), new Date().toISOString());

  return resolveCameraPreferences(db, userId, knownCameraIds);
}

const dedupe = (ids: string[]): string[] => [...new Set(ids)];
