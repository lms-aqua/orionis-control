import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, UpstreamClient } from '../../src/lib/http-upstream.ts';

describe('upstream resilience', () => {
  it('admits only one half-open recovery probe after a circuit cooldown', () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000 });
      breaker.fail();
      breaker.fail();
      expect(breaker.canRequest()).toBe(false);

      vi.advanceTimersByTime(1_001);
      expect(breaker.canRequest()).toBe(true);
      expect(breaker.canRequest()).toBe(false);

      breaker.succeed();
      expect(breaker.canRequest()).toBe(true);
      expect(breaker.canRequest()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens the circuit when its single recovery probe fails', () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 500 });
      breaker.fail();
      vi.advanceTimersByTime(501);
      expect(breaker.canRequest()).toBe(true);
      breaker.fail();
      expect(breaker.canRequest()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stay open forever when a recovery probe never reports back', () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        openMs: 500,
        probeTimeoutMs: 5_000,
      });
      breaker.fail();
      vi.advanceTimersByTime(501);
      // The probe is admitted, then its caller vanishes without ever calling
      // succeed() or fail(). Other callers are refused in the meantime.
      expect(breaker.canRequest()).toBe(true);
      expect(breaker.canRequest()).toBe(false);
      expect(breaker.state).toBe('open');

      // Once the reservation expires the circuit offers another probe, rather
      // than rejecting every request until the process restarts.
      vi.advanceTimersByTime(5_001);
      expect(breaker.state).toBe('closed');
      expect(breaker.canRequest()).toBe(true);
      breaker.succeed();
      expect(breaker.canRequest()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a recovery probe reservation for the whole probe timeout', () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        openMs: 500,
        probeTimeoutMs: 5_000,
      });
      breaker.fail();
      vi.advanceTimersByTime(501);
      expect(breaker.canRequest()).toBe(true);

      // A slow upstream must not have its probe stolen before the bound elapses.
      vi.advanceTimersByTime(4_999);
      expect(breaker.canRequest()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send a request while the circuit is open', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const client = new UpstreamClient(
      'test upstream',
      'http://upstream.invalid',
      {},
      100,
      fetchImpl,
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.request({ path: '/health' })).rejects.toMatchObject({
        code: 'UPSTREAM_ERROR',
      });
    }
    await expect(client.request({ path: '/health' })).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('coalesces identical concurrent GET requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return Response.json({ ok: true });
    });
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);

    const requests = [
      client.request({ path: '/status' }),
      client.request({ path: '/status' }),
      client.request({ path: '/status' }),
    ];
    expect(fetchImpl).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all(requests)).resolves.toHaveLength(3);
  });

  it('does not coalesce GET requests with different query strings', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    await Promise.all([
      client.request({ path: '/items', query: { page: 1 } }),
      client.request({ path: '/items', query: { page: 2 } }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retains a successful GET for its configured TTL', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ value: 1 }));
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    const first = await client.request({ path: '/status', cacheTtlMs: 1_000 });
    const second = await client.request({ path: '/status', cacheTtlMs: 1_000 });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('refreshes a cached GET after its TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => Response.json({ call: fetchImpl.mock.calls.length }));
      const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
      await client.request({ path: '/status', cacheTtlMs: 500 });
      vi.advanceTimersByTime(501);
      await client.request({ path: '/status', cacheTtlMs: 500 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates retained GETs before a write', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    await client.request({ path: '/status', cacheTtlMs: 10_000 });
    await client.request({ method: 'POST', path: '/control', body: { enabled: false } });
    await client.request({ path: '/status', cacheTtlMs: 10_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects an oversized declared response before buffering it', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('small', {
          headers: { 'content-length': '1000' },
        }),
    );
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    await expect(client.request({ path: '/large', maxResponseBytes: 16 })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('rejects a chunked response that crosses the byte cap', async () => {
    const fetchImpl = vi.fn(async () => new Response('123456789'));
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    await expect(client.request({ path: '/large', maxResponseBytes: 8 })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('returns a bounded binary response intact', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    const result = await client.request<Buffer>({
      path: '/frame',
      binary: true,
      maxResponseBytes: 4,
    });
    expect(result.data).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('keeps representations with different request headers separate', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    await client.request({ path: '/item', headers: { accept: 'application/json' } });
    await client.request({ path: '/item', headers: { accept: 'image/jpeg' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retain failed GET responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('bad', { status: 500 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    await expect(client.request({ path: '/status', cacheTtlMs: 10_000 })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
    await expect(client.request({ path: '/status', cacheTtlMs: 10_000 })).resolves.toMatchObject({
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never coalesces state-changing requests', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const client = new UpstreamClient('test', 'http://upstream.invalid', {}, 1_000, fetchImpl);
    await Promise.all([
      client.request({ method: 'POST', path: '/control', body: { value: 1 } }),
      client.request({ method: 'POST', path: '/control', body: { value: 1 } }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
