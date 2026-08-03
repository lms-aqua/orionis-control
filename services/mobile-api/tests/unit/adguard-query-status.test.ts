import { describe, expect, it } from 'vitest';

import { HttpAdGuardAdapter, mapQueryStatus, queryLogId } from '../../src/adapters/adguard/http.ts';

describe('AdGuard query status normalization', () => {
  it.each([
    'NotFilteredNotFound',
    'NotFilteredWhiteList',
    'NotFilteredAllowList',
    'NotFilteredError',
    'FilteredWhiteList',
  ])('treats %s as allowed even though it contains "filtered"', (reason) => {
    expect(mapQueryStatus(reason, false)).toBe('allowed');
  });

  it.each([
    'FilteredBlackList',
    'FilteredSafeBrowsing',
    'FilteredParental',
    'FilteredInvalid',
    'FilteredBlockedService',
    'BlockedService',
  ])('treats %s as blocked', (reason) => {
    expect(mapQueryStatus(reason, false)).toBe('blocked');
  });

  it('uses an actual blocking rule as legacy evidence when reason is absent', () => {
    expect(mapQueryStatus(undefined, true)).toBe('blocked');
  });

  it('normalizes rewrites and safe-search results separately', () => {
    expect(mapQueryStatus('Rewrite', false)).toBe('rewritten');
    expect(mapQueryStatus('SafeSearch', false)).toBe('safe_search');
  });

  it('does not call an unfamiliar non-filtering result blocked', () => {
    expect(mapQueryStatus('UpstreamError', false)).toBe('unknown');
  });

  it('does not let legacy rule evidence override an unfamiliar future reason', () => {
    expect(mapQueryStatus('FutureNotFilteredResult', true)).toBe('unknown');
  });
});

describe('AdGuard query identity', () => {
  const query = {
    at: '2026-08-03T00:00:00.123Z',
    client: '192.0.2.4',
    domain: 'example.com',
    type: 'A',
    reason: 'NotFilteredNotFound',
    rule: null,
  };

  it('is stable when the same query moves to another list position', () => {
    expect(queryLogId(query)).toBe(queryLogId({ ...query }));
  });

  it('does not collapse distinct clients or outcomes into one row', () => {
    expect(queryLogId(query)).not.toBe(queryLogId({ ...query, client: '192.0.2.5' }));
    expect(queryLogId(query)).not.toBe(queryLogId({ ...query, reason: 'FilteredBlackList' }));
  });
});

describe('AdGuard query-log transport', () => {
  it('returns mixed upstream outcomes and preserves the exact reason', async () => {
    let requestedUrl = '';
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          oldest: '2026-08-03T00:00:00Z',
          data: [
            {
              time: '2026-08-03T00:03:00Z',
              client: '192.0.2.1',
              question: { name: 'allowed.example', type: 'A' },
              reason: 'NotFilteredNotFound',
            },
            {
              time: '2026-08-03T00:02:00Z',
              client: '192.0.2.1',
              question: { name: 'blocked.example', type: 'A' },
              reason: 'FilteredBlackList',
              rules: [{ text: '||blocked.example^', filter_list_id: 1 }],
            },
            {
              time: '2026-08-03T00:01:00Z',
              client: '192.0.2.1',
              question: { name: 'future.example', type: 'A' },
              reason: 'FutureNotFilteredResult',
              rules: [{ text: '||future.example^', filter_list_id: 1 }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const adapter = new HttpAdGuardAdapter(
      'https://adguard.example.test',
      'user',
      'password',
      1_000,
      fetchImpl as typeof fetch,
    );

    const result = await adapter.getQueryLog({ limit: 100, status: 'all' });

    expect(result.items.map((item) => item.status)).toEqual(['allowed', 'blocked', 'unknown']);
    expect(result.items.map((item) => item.reason)).toEqual([
      'NotFilteredNotFound',
      'FilteredBlackList',
      'FutureNotFilteredResult',
    ]);
    expect(new URL(requestedUrl).searchParams.has('response_status')).toBe(false);
    expect(result.oldest).toBe('2026-08-03T00:00:00Z');
    expect(result.scannedCount).toBe(3);

    const allowed = await adapter.getQueryLog({ limit: 100, status: 'allowed' });
    const blocked = await adapter.getQueryLog({ limit: 100, status: 'blocked' });
    expect(allowed.items.map((item) => item.domain)).toEqual(['allowed.example']);
    expect(blocked.items.map((item) => item.domain)).toEqual(['blocked.example']);
  });
});
