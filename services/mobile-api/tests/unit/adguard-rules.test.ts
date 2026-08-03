import { describe, expect, it, vi } from 'vitest';
import { HttpAdGuardAdapter, validateRule } from '../../src/adapters/adguard/http.ts';

describe('custom filtering rule validation', () => {
  it('accepts adblock-style block rules', () => {
    expect(validateRule('||ads.example.com^')).toEqual({
      ok: true,
      normalised: '||ads.example.com^',
    });
    expect(validateRule('||tracker.example.com^$third-party').ok).toBe(true);
  });

  it('accepts allow rules', () => {
    expect(validateRule('@@||cdn.example.com^').ok).toBe(true);
  });

  it('accepts hosts-style and regex rules', () => {
    expect(validateRule('0.0.0.0 ads.example.com').ok).toBe(true);
    expect(validateRule('/^ads?\\./').ok).toBe(true);
  });

  it('accepts comments', () => {
    expect(validateRule('! this is a comment').ok).toBe(true);
    expect(validateRule('# also a comment').ok).toBe(true);
  });

  it('accepts a bare domain', () => {
    expect(validateRule('example.com').ok).toBe(true);
  });

  it('rejects empty and whitespace-only rules', () => {
    expect(validateRule('')).toEqual({ ok: false, reason: 'The rule is empty.' });
    expect(validateRule('    ').ok).toBe(false);
  });

  it('rejects rules longer than 512 characters', () => {
    const result = validateRule(`||${'a'.repeat(600)}.com^`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('512');
  });

  it('rejects rules containing control characters', () => {
    const result = validateRule('||evil.com^\u0007injected');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('control characters');
  });

  it('rejects unrecognised syntax rather than forwarding it upstream', () => {
    const result = validateRule('DROP TABLE filters;');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Unrecognised rule syntax');
  });

  it('trims surrounding whitespace when normalising', () => {
    const result = validateRule('   ||ads.example.com^   ');
    expect(result).toEqual({ ok: true, normalised: '||ads.example.com^' });
  });
});

describe('AdGuard protection mutation isolation', () => {
  it('does not retry a protection mutation through another endpoint after a generic 5xx', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request) => new Response('failed', { status: 500 }),
    );
    const adapter = new HttpAdGuardAdapter(
      'http://adguard.invalid',
      'user',
      'password',
      1_000,
      fetchImpl,
    );
    await expect(
      adapter.setProtection({ enabled: true, durationSeconds: null, reason: null }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/control/protection');
  });

  it('uses the legacy DNS-config endpoint only after a proven 404', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      );
      paths.push(url.pathname);
      if (url.pathname === '/control/protection') return new Response('missing', { status: 404 });
      if (url.pathname === '/control/dns_config') return Response.json({});
      if (url.pathname === '/control/status') {
        return Response.json({ protection_enabled: true, running: true });
      }
      if (url.pathname === '/control/filtering/status') return Response.json({ enabled: true });
      return new Response('unexpected', { status: 500 });
    });
    const adapter = new HttpAdGuardAdapter(
      'http://adguard.invalid',
      'user',
      'password',
      1_000,
      fetchImpl,
    );
    await expect(
      adapter.setProtection({ enabled: true, durationSeconds: null, reason: null }),
    ).resolves.toMatchObject({ protectionEnabled: true });
    expect(paths).toEqual([
      '/control/protection',
      '/control/dns_config',
      '/control/status',
      '/control/filtering/status',
    ]);
  });
});
