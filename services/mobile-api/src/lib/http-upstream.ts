/**
 * Shared upstream HTTP helper: bounded timeouts, a small circuit breaker and
 * uniform normalisation of upstream failures into AppError.
 *
 * No upstream response body is ever forwarded verbatim — upstreams can echo
 * credentials, internal paths and stack traces.
 */
import { AppError } from './errors.ts';
import { redactUrl } from './redact.ts';

export interface CircuitOptions {
  failureThreshold: number;
  openMs: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(private readonly opts: CircuitOptions = { failureThreshold: 5, openMs: 15_000 }) {}

  get isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt >= this.opts.openMs) {
      // half-open: allow one probe
      this.openedAt = null;
      this.failures = this.opts.failureThreshold - 1;
      return false;
    }
    return true;
  }

  succeed(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  fail(): void {
    this.failures += 1;
    if (this.failures >= this.opts.failureThreshold) this.openedAt = Date.now();
  }

  get state(): 'closed' | 'open' {
    return this.isOpen ? 'open' : 'closed';
  }
}

export interface UpstreamRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Overrides the client default. */
  timeoutMs?: number;
  /** Expect a binary payload (snapshots). */
  binary?: boolean;
}

export interface UpstreamResult<T> {
  status: number;
  data: T;
}

export class UpstreamClient {
  readonly breaker = new CircuitBreaker();

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly defaultHeaders: Record<string, string>,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string, query?: UpstreamRequest['query']): string {
    const u = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T>(req: UpstreamRequest): Promise<UpstreamResult<T>> {
    if (this.breaker.isOpen) {
      throw new AppError(
        'CIRCUIT_OPEN',
        `${this.name} is failing repeatedly and requests are paused briefly. Retry shortly.`,
      );
    }

    const url = this.url(req.path, req.query);
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(req.headers ?? {}) };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: req.method ?? 'GET',
        headers,
        body,
        signal: AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      this.breaker.fail();
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AppError('UPSTREAM_TIMEOUT', `${this.name} did not respond in time.`, {
          endpoint: redactUrl(url),
        });
      }
      throw new AppError('UPSTREAM_UNAVAILABLE', `${this.name} could not be reached.`, {
        endpoint: redactUrl(url),
      });
    }

    if (res.status >= 500) {
      this.breaker.fail();
      throw new AppError('UPSTREAM_ERROR', `${this.name} returned an error (${res.status}).`, {
        status: res.status,
      });
    }
    if (res.status === 401 || res.status === 403) {
      this.breaker.succeed(); // reachable, just unauthorised — not a health failure
      throw new AppError(
        'UPSTREAM_ERROR',
        `${this.name} rejected the gateway's service credentials. An administrator must check the configured credentials.`,
        { status: res.status },
      );
    }
    if (res.status === 404) {
      this.breaker.succeed();
      throw new AppError('NOT_FOUND', `${this.name} has no such resource.`);
    }
    if (!res.ok) {
      this.breaker.succeed();
      throw new AppError('UPSTREAM_ERROR', `${this.name} rejected the request (${res.status}).`, {
        status: res.status,
      });
    }

    this.breaker.succeed();

    if (req.binary) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, data: buf as unknown as T };
    }

    const text = await res.text();
    if (!text) return { status: res.status, data: null as unknown as T };
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { status: res.status, data: text as unknown as T };
    }
  }

  /** Cheap reachability probe used by health aggregation. */
  async probe(
    path: string,
    timeoutMs = 3000,
  ): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      await this.request({ path, timeoutMs });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: err instanceof AppError ? err.code : 'INTERNAL_ERROR',
      };
    }
  }
}
