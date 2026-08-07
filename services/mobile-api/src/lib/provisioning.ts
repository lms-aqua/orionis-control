/**
 * Bridge provisioning, requested by the gateway and performed outside it.
 *
 * Some camera sources are not systems you point at. Blink needs a lostblink and
 * a MediaMTX running beside the gateway to translate its transports; Wyze needs
 * docker-wyze-bridge. Standing those up means talking to Docker, and the Docker
 * socket is root-equivalent on the host — ADR 0003/0005 refuses to give this
 * process that, and a convenience feature is nowhere near worth the exception.
 *
 * So this is the same shape as retention (`lib/retention.ts`) and the Authelia
 * restart (`lib/infra-control.ts`), scaled up by exactly one idea: the request
 * names a **template**, and the applier owns the templates. The gateway's total
 * additional capability is "write one small file naming one of N vetted things".
 * It cannot choose an image, a volume, a port, or an environment variable, and
 * no amount of creativity in the app can turn "start the lostblink template"
 * into "start something else".
 *
 * Direction of credentials is deliberately one-way. A request may carry values
 * the instance itself needs — lostblink signs in to Blink on its own behalf, so
 * it needs the same password — and the applier deletes the request once it has
 * consumed it. Nothing secret travels back: a bridge API key is minted here and
 * handed down, so the status file the applier writes contains addresses and
 * prose and nothing else. "Secrets only ever go outward" is a rule that can be
 * checked by reading one function; "sometimes, in this shape" is not.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.ts';

/**
 * States a bridge instance moves through.
 *
 * `pending` and `removing` are gateway-written — they mean a request exists and
 * nobody has picked it up. Everything else is the applier reporting.
 */
export type ProvisioningState =
  'pending' | 'provisioning' | 'ready' | 'failed' | 'removing' | 'removed';

export type ProvisioningAction = 'create' | 'remove';

/** Written by the gateway. Read, acted on, and deleted by the applier. */
export interface ProvisioningRequest {
  id: string;
  connectionId: string;
  provider: string;
  /** Must name a template the applier ships. Never a path or an image. */
  template: string;
  action: ProvisioningAction;
  /** Compose project suffix. Slug-shaped, so it cannot escape into an argument. */
  instance: string;
  requestedAt: string;
  /** Audit only. The applier does no authorisation of its own. */
  requestedBy: string | null;
  /**
   * Values the instance needs for itself — a Blink password, a minted API key.
   * Absent for templates that need none.
   */
  handover?: Record<string, string>;
}

/** Written by the applier. Never contains a credential. */
export interface ProvisioningStatus {
  /** The request this answers. A mismatch means it is stale and is ignored. */
  id: string;
  connectionId: string;
  state: ProvisioningState;
  /** Shown verbatim to the operator, so it must read as an explanation. */
  message: string;
  updatedAt: string;
  /** Resolved addresses, keyed by the provider setting they fill in. */
  settings?: Record<string, string>;
}

const REQUESTS_DIR = 'requests';
const STATUS_DIR = 'status';

/**
 * Instance names go into a compose project name and a container name, so the
 * character set is narrowed to what Docker accepts and what cannot be read as
 * anything but a name — no dots, no slashes, no leading dash.
 */
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidInstanceName(instance: string): boolean {
  return INSTANCE_PATTERN.test(instance);
}

/** Connection ids are ours, but they name a file, so they are checked anyway. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertFileSafeId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new AppError('VALIDATION_FAILED', `${label} is not a usable identifier.`);
  }
  return value;
}

/** Atomic write: the applier may read at any moment, and half a JSON document
 *  would be acted on as though it were whole. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  // 0600 because a create request can carry the credential the instance signs
  // in with. The directory should be locked down too; this is the belt.
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    // Absent is the normal state — it just means nothing has been requested, or
    // the applier has not answered yet.
    return null;
  }
}

export class ProvisioningDirectory {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /** Whether this deployment can provision at all. */
  get available(): boolean {
    return this.#dir !== '';
  }

  #requestPath(connectionId: string): string {
    return join(this.#dir, REQUESTS_DIR, `${assertFileSafeId(connectionId, 'Connection')}.json`);
  }

  #statusPath(connectionId: string): string {
    return join(this.#dir, STATUS_DIR, `${assertFileSafeId(connectionId, 'Connection')}.json`);
  }

  #assertAvailable(): void {
    if (!this.available) {
      throw new AppError(
        'SERVICE_NOT_CONFIGURED',
        'This gateway cannot set up bridges: no provisioning directory is configured. Start the bridge yourself and enter its address instead.',
      );
    }
  }

  /**
   * How many instances already exist, counting requests and answers alike.
   *
   * A cap is the difference between "an administrator can start one of N vetted
   * templates" and "an administrator can fill the disk with containers". It is
   * enforced here rather than only in the applier so the refusal reaches the
   * person who asked, with a reason.
   */
  async instanceCount(): Promise<number> {
    if (!this.available) return 0;
    const seen = new Set<string>();
    for (const sub of [REQUESTS_DIR, STATUS_DIR]) {
      try {
        for (const name of await readdir(join(this.#dir, sub))) {
          if (name.endsWith('.json')) seen.add(name);
        }
      } catch {
        // Not created yet: nothing has ever been provisioned.
      }
    }
    return seen.size;
  }

  async write(request: ProvisioningRequest): Promise<void> {
    this.#assertAvailable();
    if (!isValidInstanceName(request.instance)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The instance name must be lower-case letters, digits and hyphens.',
      );
    }
    const path = this.#requestPath(request.connectionId);
    try {
      await mkdir(join(this.#dir, REQUESTS_DIR), { recursive: true, mode: 0o700 });
      await mkdir(join(this.#dir, STATUS_DIR), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(path, request);
    } catch {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'The setup request could not be recorded. The shared directory may not be writable.',
      );
    }
  }

  /** The applier's latest answer, or null while it has not answered yet. */
  async readStatus(connectionId: string): Promise<ProvisioningStatus | null> {
    if (!this.available) return null;
    const status = await readJson<ProvisioningStatus>(this.#statusPath(connectionId));
    if (!status || typeof status.id !== 'string' || typeof status.state !== 'string') return null;
    return status;
  }

  /** Whether a request is still sitting unclaimed. The applier deletes it. */
  async hasPendingRequest(connectionId: string): Promise<boolean> {
    if (!this.available) return false;
    return (await readJson<ProvisioningRequest>(this.#requestPath(connectionId))) !== null;
  }

  /**
   * Drops both files for a connection.
   *
   * Called once a teardown has been confirmed applied, so a connection id can be
   * reused without inheriting a previous instance's answer.
   */
  async forget(connectionId: string): Promise<void> {
    if (!this.available) return;
    for (const path of [this.#requestPath(connectionId), this.#statusPath(connectionId)]) {
      try {
        await unlink(path);
      } catch {
        // Already gone is the desired end state.
      }
    }
  }
}
