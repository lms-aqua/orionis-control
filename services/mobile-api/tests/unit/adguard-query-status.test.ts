import { describe, expect, it } from 'vitest';

import { mapQueryStatus, queryLogId } from '../../src/adapters/adguard/http.ts';

describe('AdGuard query status normalization', () => {
  it.each(['NotFilteredNotFound', 'NotFilteredAllowList', 'FilteredWhiteList'])(
    'treats %s as allowed even though it contains "filtered"',
    (reason) => {
      expect(mapQueryStatus(reason, false)).toBe('allowed');
    },
  );

  it.each(['FilteredBlackList', 'FilteredBlockedService', 'BlockedService'])(
    'treats %s as blocked',
    (reason) => {
      expect(mapQueryStatus(reason, false)).toBe('blocked');
    },
  );

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
