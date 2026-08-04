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
  /**
   * How long a half-open probe reservation is honoured before it is treated as
   * abandoned. Must exceed the upstream request timeout, or a slow-but-working
   * upstream loses probes it would have passed.
   */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  /** When the outstanding half-open probe was admitted, or null if there is none. */
  private halfOpenSince: number | null = null;

  constructor(private readonly opts: CircuitOptions = { failureThreshold: 5, openMs: 15_000 }) {}

  /**
   * Whether a probe reservation is still outstanding, expiring it if it is older
   * than the bound. A probe that never reports back must not hold the circuit
   * open forever: every caller is then rejected until the process restarts, even
   * though the upstream may be healthy.
   */
  private probePending(now: number): boolean {
    if (this.halfOpenSince === null) return false;
    if (now - this.halfOpenSince < (this.opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)) {
      return true;
    }
    this.halfOpenSince = null;
    return false;
  }

  get isOpen(): boolean {
    if (this.openedAt === null) return false;
    const now = Date.now();
    return now - this.openedAt < this.opts.openMs || this.probePending(now);
  }

  /**
   * Acquires permission for a request. After the cooldown exactly one probe is
   * admitted, preventing a recovering upstream from receiving a request herd.
   */
  canRequest(): boolean {
    if (this.openedAt === null) return true;
    const now = Date.now();
    if (now - this.openedAt < this.opts.openMs) return false;
    if (this.probePending(now)) return false;
    this.halfOpenSince = now;
    return true;
  }

  succeed(): void {
    this.failures = 0;
    this.openedAt = null;
    this.halfOpenSince = null;
  }

  fail(): void {
    if (this.probePending(Date.now())) {
      this.failures = this.opts.failureThreshold;
      this.openedAt = Date.now();
      this.halfOpenSince = null;
      return;
    }
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
  /** Briefly cache a successful GET. Writes always invalidate this cache. */
  cacheTtlMs?: number;
  /** Hard response cap. Defaults to 2 MiB for text and 16 MiB for binary. */
  maxResponseBytes?: number;
}

export interface UpstreamResult<T> {
  status: number;
  data: T;
}

export class UpstreamClient {
  readonly breaker = new CircuitBreaker();
  private readonly inFlight = new Map<string, Promise<UpstreamResult<unknown>>>();
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: UpstreamResult<unknown> }
  >();
  private static readonly CACHE_MAX_ENTRIES = 64;
  private static readonly TEXT_MAX_BYTES = 2 * 1024 * 1024;
  private static readonly BINARY_MAX_BYTES = 16 * 1024 * 1024;

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

  private cacheKey(
    method: string,
    url: string,
    headers: Record<string, string>,
    binary: boolean,
  ): string {
    const headerKey = Object.entries(headers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key.toLowerCase()}:${value}`)
      .join('|');
    return `${method}|${url}|${binary ? 'binary' : 'text'}|${headerKey}`;
  }

  private remember(key: string, result: UpstreamResult<unknown>, ttlMs: number): void {
    this.cache.delete(key);
    this.cache.set(key, { result, expiresAt: Date.now() + ttlMs });
    while (this.cache.size > UpstreamClient.CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  private async readBounded(res: Response, maxBytes: number): Promise<Buffer> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new AppError('UPSTREAM_ERROR', `${this.name} returned an oversized response.`, {
        maxBytes,
      });
    }
    if (!res.body) return Buffer.alloc(0);

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new AppError('UPSTREAM_ERROR', `${this.name} returned an oversized response.`, {
            maxBytes,
          });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  async request<T>(req: UpstreamRequest): Promise<UpstreamResult<T>> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = this.url(req.path, req.query);
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(req.headers ?? {}) };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }

    const cacheable = method === 'GET' && body === undefined;
    const key = this.cacheKey(method, url, headers, Boolean(req.binary));
    if (cacheable && (req.cacheTtlMs ?? 0) > 0) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.result as UpstreamResult<T>;
      if (cached) this.cache.delete(key);
    }

    // Coalesce identical concurrent reads even when they are not retained.
    if (cacheable) {
      const existing = this.inFlight.get(key);
      if (existing) return existing as Promise<UpstreamResult<T>>;
    } else {
      // A failed write can still have reached the upstream. Invalidate before
      // sending it so no later read serves state from before an ambiguous write.
      this.invalidateCache();
    }

    const run = this.performRequest<T>(req, method, url, headers, body);
    if (cacheable) this.inFlight.set(key, run as Promise<UpstreamResult<unknown>>);
    try {
      const result = await run;
      if (cacheable && (req.cacheTtlMs ?? 0) > 0) {
        this.remember(key, result as UpstreamResult<unknown>, req.cacheTtlMs!);
      }
      return result;
    } finally {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    }
  }

  private async performRequest<T>(
    req: UpstreamRequest,
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<UpstreamResult<T>> {
    if (!this.breaker.canRequest()) {
      throw new AppError(
        'CIRCUIT_OPEN',
        `${this.name} is failing repeatedly and requests are paused briefly. Retry shortly.`,
      );
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
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
      await res.body?.cancel().catch(() => undefined);
      throw new AppError('UPSTREAM_ERROR', `${this.name} returned an error (${res.status}).`, {
        status: res.status,
      });
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      this.breaker.succeed(); // reachable, just unauthorised — not a health failure
      throw new AppError(
        'UPSTREAM_ERROR',
        `${this.name} rejected the gateway's service credentials. An administrator must check the configured credentials.`,
        { status: res.status },
      );
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      this.breaker.succeed();
      throw new AppError('NOT_FOUND', `${this.name} has no such resource.`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      this.breaker.succeed();
      throw new AppError('UPSTREAM_ERROR', `${this.name} rejected the request (${res.status}).`, {
        status: res.status,
      });
    }

    const maxBytes =
      req.maxResponseBytes ??
      (req.binary ? UpstreamClient.BINARY_MAX_BYTES : UpstreamClient.TEXT_MAX_BYTES);
    let buf: Buffer;
    try {
      buf = await this.readBounded(res, maxBytes);
    } catch (error) {
      this.breaker.fail();
      if (error instanceof AppError) throw error;
      throw new AppError('UPSTREAM_ERROR', `${this.name} returned an incomplete response.`, {
        endpoint: redactUrl(url),
      });
    }
    this.breaker.succeed();
    if (req.binary) {
      return { status: res.status, data: buf as unknown as T };
    }

    const text = buf.toString('utf8');
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
