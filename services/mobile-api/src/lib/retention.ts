/**
 * Recording retention, requested by the app and applied outside the gateway.
 *
 * Retention lives in the recorder's own config, and changing it means editing that
 * config and restarting the recorder. Doing that from here would require the
 * Docker socket, which is equivalent to root on the host — ADR 0003/0005 rejects
 * that outright, and a settings toggle is nowhere near worth it.
 *
 * So this follows the pattern ADR 0005 already established for the Wyze bridge:
 * zero new privilege. The gateway writes a requested value to one file in a
 * directory it shares with the host; a host-side applier notices, edits the
 * recorder's config, restarts it, and writes back what it actually applied. The
 * gateway's entire additional capability is "write one small file".
 *
 * Because request and applied are separate files, the app can honestly show
 * "7 days, changing to 14" instead of pretending a change took effect the moment
 * it was accepted.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.ts';

/** Guard rails: a day keeps almost nothing, and a year would fill any disk. */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

export interface RetentionState {
  /** Currently in force, as reported by the applier. Null when never applied. */
  appliedDays: number | null;
  /** Requested but not yet applied. Null when there is nothing outstanding. */
  requestedDays: number | null;
  requestedAt: string | null;
  /** Whether a request is still waiting for the applier to act. */
  pending: boolean;
}

const REQUEST_FILE = 'requested-retention.json';
const APPLIED_FILE = 'applied-retention.json';

async function readJson(dir: string, file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, file), 'utf8')) as Record<string, unknown>;
  } catch {
    // Absent or unreadable is a normal state, not a failure: it just means
    // nothing has been requested (or applied) yet.
    return null;
  }
}

const asDays = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_RETENTION_DAYS && n <= MAX_RETENTION_DAYS ? n : null;
};

/**
 * Reads the current state.
 *
 * `fallbackDays` is the value the gateway was configured with, used when the
 * applier has not written anything yet — so a fresh install still reports the
 * retention actually in force rather than "unknown".
 */
export async function readRetention(
  dir: string,
  fallbackDays: number | null,
): Promise<RetentionState> {
  if (!dir) {
    return { appliedDays: fallbackDays, requestedDays: null, requestedAt: null, pending: false };
  }

  const applied = await readJson(dir, APPLIED_FILE);
  const requested = await readJson(dir, REQUEST_FILE);

  const appliedDays = asDays(applied?.days) ?? fallbackDays;
  const requestedDays = asDays(requested?.days);

  return {
    appliedDays,
    requestedDays,
    requestedAt: typeof requested?.at === 'string' ? requested.at : null,
    // Only pending while it actually differs from what is in force. A request
    // that matches reality is already satisfied.
    pending: requestedDays !== null && requestedDays !== appliedDays,
  };
}

/** Records a request for the host-side applier to pick up. */
export async function requestRetention(
  dir: string,
  days: number,
  actor: string,
): Promise<RetentionState> {
  if (!dir) {
    throw new AppError(
      'SERVICE_NOT_CONFIGURED',
      'Retention cannot be changed from here: no control directory is configured.',
    );
  }
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Retention must be a whole number of days between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}.`,
    );
  }

  try {
    await mkdir(dir, { recursive: true });
    // Written atomically: the applier may read at any moment, and half a JSON
    // document would be worse than an old value.
    const tmp = join(dir, `${REQUEST_FILE}.tmp`);
    await writeFile(
      tmp,
      `${JSON.stringify({ days, at: new Date().toISOString(), by: actor }, null, 2)}\n`,
    );
    const { rename } = await import('node:fs/promises');
    await rename(tmp, join(dir, REQUEST_FILE));
  } catch {
    throw new AppError('UPSTREAM_UNAVAILABLE', 'The retention request could not be recorded.');
  }

  return readRetention(dir, null);
}
