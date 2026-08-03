import { describe, expect, it } from 'vitest';

import { mapQueryStatus } from '../../src/adapters/adguard/http.ts';

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
