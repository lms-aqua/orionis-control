/**
 * Queued Authelia restarts.
 *
 * Restarting Authelia is not something the gateway can or should do. It has no
 * Docker access by design (ADR 0003/0005), and the restart signs out every SSO
 * user across every protected site — including the session that asked for it, so
 * the caller cannot see the result of its own request.
 *
 * Same shape as retention: the gateway writes a request to a directory it shares
 * with the host, and the host-side applier performs the restart and writes back
 * what it did. Request and applied are separate files so the app can honestly show
 * "queued" rather than implying the restart already happened.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.ts';

export interface AutheliaRestartState {
  requestedAt: string | null;
  requestedBy: string | null;
  lastRestartedAt: string | null;
  /** A request is outstanding when it is newer than the last completed restart. */
  pending: boolean;
  /** Whether this deployment can queue one at all. */
  available: boolean;
}

const REQUEST_FILE = 'requested-authelia-restart.json';
const APPLIED_FILE = 'applied-authelia-restart.json';

async function readJson(dir: string, file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, file), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const asIso = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

export async function readAutheliaRestart(dir: string): Promise<AutheliaRestartState> {
  if (!dir) {
    return {
      requestedAt: null,
      requestedBy: null,
      lastRestartedAt: null,
      pending: false,
      available: false,
    };
  }

  const requested = await readJson(dir, REQUEST_FILE);
  const applied = await readJson(dir, APPLIED_FILE);

  const requestedAt = asIso(requested?.at);
  const lastRestartedAt = asIso(applied?.at);

  return {
    requestedAt,
    requestedBy: typeof requested?.by === 'string' ? requested.by : null,
    lastRestartedAt,
    // Newer than the last completed restart means it has not been served yet.
    pending:
      requestedAt !== null &&
      (lastRestartedAt === null || Date.parse(requestedAt) > Date.parse(lastRestartedAt)),
    available: true,
  };
}

export async function requestAutheliaRestart(
  dir: string,
  actor: string,
): Promise<AutheliaRestartState> {
  if (!dir) {
    throw new AppError(
      'SERVICE_NOT_CONFIGURED',
      'Authelia cannot be restarted from here: no control directory is configured.',
    );
  }

  try {
    await mkdir(dir, { recursive: true });
    // Atomic: the applier may read at any moment, and a half-written request
    // would be worse than none.
    const tmp = join(dir, `${REQUEST_FILE}.tmp`);
    await writeFile(
      tmp,
      `${JSON.stringify({ at: new Date().toISOString(), by: actor }, null, 2)}\n`,
    );
    await rename(tmp, join(dir, REQUEST_FILE));
  } catch {
    throw new AppError('UPSTREAM_UNAVAILABLE', 'The restart request could not be recorded.');
  }

  return readAutheliaRestart(dir);
}
