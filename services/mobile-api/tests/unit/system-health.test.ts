import { describe, expect, it, vi } from 'vitest';
import { collectHealth } from '../../src/routes/system.ts';

describe('system health aggregation', () => {
  it('starts independent upstream probes concurrently', async () => {
    let releaseAuth!: () => void;
    let releaseOrionis!: () => void;
    let releaseAdGuard!: () => void;
    const authGate = new Promise<void>((resolve) => (releaseAuth = resolve));
    const orionisGate = new Promise<void>((resolve) => (releaseOrionis = resolve));
    const adguardGate = new Promise<void>((resolve) => (releaseAdGuard = resolve));

    const discover = vi.fn(async () => authGate);
    const listServiceHealth = vi.fn(async () => {
      await orionisGate;
      return [];
    });
    const probe = vi.fn(async () => {
      await adguardGate;
      return { ok: true, latencyMs: 1 };
    });

    const pending = collectHealth({
      services: {
        config: {
          orionis: { configured: true },
          adguard: { configured: true },
          oidc: { configured: true },
        },
        orionis: { configured: true, listServiceHealth },
        adguard: { configured: true, probe },
        oidc: { configured: true, discover },
        push: { configured: false },
        db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
        startedAt: new Date(),
      },
    });

    expect(discover).toHaveBeenCalledOnce();
    expect(listServiceHealth).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();

    releaseAuth();
    releaseOrionis();
    releaseAdGuard();
    const result = await pending;
    expect(result.find((service) => service.id === 'adguard')?.status).toBe('healthy');
  });

  const fixture = () => {
    const discover = vi.fn(async () => ({}));
    const listServiceHealth = vi.fn(async () => []);
    const probe = vi.fn(async () => ({ ok: true, latencyMs: 1 }));
    return {
      discover,
      listServiceHealth,
      probe,
      request: {
        services: {
          config: {
            orionis: { configured: true },
            adguard: { configured: true },
            oidc: { configured: true },
          },
          orionis: { configured: true, listServiceHealth },
          adguard: { configured: true, probe },
          oidc: { configured: true, discover },
          push: { configured: false },
          db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
          startedAt: new Date(),
        },
      },
    };
  };

  it('reuses a completed health snapshot inside the short TTL', async () => {
    const f = fixture();
    await collectHealth(f.request);
    await collectHealth(f.request);
    expect(f.discover).toHaveBeenCalledOnce();
    expect(f.listServiceHealth).toHaveBeenCalledOnce();
    expect(f.probe).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent whole-health collections', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([collectHealth(f.request), collectHealth(f.request)]);
    expect(second).toBe(first);
    expect(f.probe).toHaveBeenCalledOnce();
  });

  it('lets an explicit recheck bypass a retained health value', async () => {
    const f = fixture();
    await collectHealth(f.request);
    await collectHealth(f.request, true);
    expect(f.probe).toHaveBeenCalledTimes(2);
  });

  it('refreshes health after the retained value expires', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await collectHealth(f.request);
      vi.advanceTimersByTime(5_001);
      await collectHealth(f.request);
      expect(f.probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
