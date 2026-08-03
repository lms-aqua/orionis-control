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
});
