/**
 * Client for the self-hosted Caddy manager, which owns Caddy and Authelia config.
 *
 * The gateway does not edit Caddy or Authelia itself. That would need either the
 * Docker socket or write access to Authelia's secrets, and ADR 0003/0005 refuses
 * both. caddymanager already holds that privilege and the logic, so this is a
 * narrow, audited proxy in front of it rather than a reimplementation.
 *
 * The API key never leaves the server: it is read from config, sent as a header,
 * and deliberately never included in an error message or a response.
 */
import { AppError } from '../../lib/errors.ts';

export interface CaddyServerStatus {
  id: string;
  name: string;
  status: string;
  lastPinged: string | null;
}

export interface CaddyStatusSummary {
  total: number;
  online: number;
  offline: number;
  unknown: number;
  servers: CaddyServerStatus[];
}

export interface AutheliaRuntime {
  running: boolean;
  status: string;
  health: string | null;
  startedAt: string | null;
  restartCount: number | null;
  image: string | null;
}

export interface AutheliaBackup {
  name: string;
  size: number;
  modifiedAt: string | null;
}

export interface AutheliaUser {
  username: string;
  displayName: string | null;
  email: string | null;
  groups: string[];
  disabled: boolean;
}

interface Envelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

export class CaddyManagerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new AppError(
        'SERVICE_NOT_CONFIGURED',
        'Infrastructure management is not configured on this gateway.',
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'The infrastructure manager did not respond.');
    }

    const text = await response.text();
    let parsed: Envelope<T> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Envelope<T>) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      // Pass its own explanation through -- an operator fixing a broken config
      // needs the real reason -- but never the request that carried the key.
      const detail = parsed?.message ?? 'The infrastructure manager rejected the request.';
      if (response.status === 401 || response.status === 403) {
        throw new AppError(
          'UPSTREAM_ERROR',
          'The gateway is not authorised by the infrastructure manager.',
        );
      }
      if (response.status === 404) throw new AppError('NOT_FOUND', detail);
      throw new AppError(response.status >= 500 ? 'UPSTREAM_ERROR' : 'VALIDATION_FAILED', detail);
    }

    return (parsed?.data ?? (parsed as unknown as T)) as T;
  }

  // --- Caddy ---------------------------------------------------------------

  async caddyStatus(): Promise<CaddyStatusSummary> {
    const raw = await this.call<{
      total?: number;
      online?: number;
      offline?: number;
      unknown?: number;
      details?: { id?: string; name?: string; status?: string; lastPinged?: string }[];
    }>('GET', '/caddy/servers/status');
    return {
      total: raw.total ?? 0,
      online: raw.online ?? 0,
      offline: raw.offline ?? 0,
      unknown: raw.unknown ?? 0,
      servers: (raw.details ?? []).map((d) => ({
        id: String(d.id ?? ''),
        name: d.name ?? '',
        status: d.status ?? 'unknown',
        lastPinged: d.lastPinged ?? null,
      })),
    };
  }

  /** The configuration Caddy is running right now. */
  async caddyCurrentConfig(serverId: string): Promise<{ raw: string; json: unknown }> {
    const raw = await this.call<{ raw?: string; config?: unknown }>(
      'GET',
      `/caddy/servers/${encodeURIComponent(serverId)}/current-config`,
    );
    return {
      raw: typeof raw.raw === 'string' ? raw.raw : JSON.stringify(raw.config ?? {}, null, 2),
      json: raw.config ?? null,
    };
  }

  async caddyApplyConfig(configId: string, content: string): Promise<void> {
    await this.call('PUT', `/caddy/configs/${encodeURIComponent(configId)}/content`, { content });
    await this.call('POST', `/caddy/configs/${encodeURIComponent(configId)}/apply`, {});
  }

  // --- Authelia ------------------------------------------------------------

  async autheliaRuntime(): Promise<AutheliaRuntime> {
    const raw = await this.call<Record<string, unknown>>('GET', '/authelia/runtime');
    return {
      running: Boolean(raw.running),
      status: String(raw.status ?? 'unknown'),
      health: typeof raw.health === 'string' ? raw.health : null,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
      restartCount: typeof raw.restartCount === 'number' ? raw.restartCount : null,
      image: typeof raw.image === 'string' ? raw.image : null,
    };
  }

  /** Authelia's configuration. Contains secrets, so callers must be admin-gated. */
  async autheliaConfig(): Promise<{ content: string }> {
    const raw = await this.call<Record<string, unknown>>('GET', '/authelia/');
    const content =
      typeof raw.content === 'string'
        ? raw.content
        : typeof raw.configuration === 'string'
          ? raw.configuration
          : typeof raw.raw === 'string'
            ? raw.raw
            : '';
    return { content };
  }

  /** Asks Authelia's own validator whether a config is acceptable. */
  async autheliaValidate(content: string): Promise<{ valid: boolean; message: string | null }> {
    try {
      const raw = await this.call<Record<string, unknown>>('POST', '/authelia/validate', {
        content,
      });
      return {
        valid: raw.valid === undefined ? true : Boolean(raw.valid),
        message: typeof raw.message === 'string' ? raw.message : null,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'VALIDATION_FAILED') {
        return { valid: false, message: error.message };
      }
      throw error;
    }
  }

  async autheliaApply(content: string): Promise<void> {
    await this.call('POST', '/authelia/apply', { content });
  }

  async autheliaUsers(): Promise<AutheliaUser[]> {
    const raw = await this.call<unknown>('GET', '/authelia/users');
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { users?: unknown[] })?.users)
        ? (raw as { users: unknown[] }).users
        : [];
    return list.map((entry) => {
      const u = entry as Record<string, unknown>;
      return {
        username: String(u.username ?? u.name ?? ''),
        displayName: typeof u.displayname === 'string' ? u.displayname : null,
        email: typeof u.email === 'string' ? u.email : null,
        groups: Array.isArray(u.groups) ? u.groups.map(String) : [],
        disabled: Boolean(u.disabled),
      };
    });
  }

  async autheliaSetPassword(username: string, password: string): Promise<void> {
    await this.call('PUT', `/authelia/users/${encodeURIComponent(username)}/password`, {
      password,
    });
  }

  async autheliaBackups(): Promise<AutheliaBackup[]> {
    const raw = await this.call<unknown>('GET', '/authelia/backups');
    const list = Array.isArray(raw) ? raw : [];
    return list.map((entry) => {
      const b = entry as Record<string, unknown>;
      return {
        name: String(b.name ?? ''),
        size: Number(b.size ?? 0),
        modifiedAt: typeof b.modifiedAt === 'string' ? b.modifiedAt : null,
      };
    });
  }

  async autheliaRestoreBackup(name: string): Promise<void> {
    await this.call('POST', '/authelia/backups/restore', { name });
  }
}
