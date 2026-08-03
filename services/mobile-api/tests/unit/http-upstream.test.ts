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
});
