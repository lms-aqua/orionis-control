import { describe, expect, it } from 'vitest';

import { mapQueryStatus } from '../../src/adapters/adguard/http.ts';
import { mergeCoverage, type Span } from '../../src/lib/coverage.ts';
import { REDACTED, redactString } from '../../src/lib/redact.ts';
import { mintTurnCredential, turnIceServers } from '../../src/lib/turn.ts';

const cases = Array.from({ length: 50 }, (_, index) => index);

describe('deep generated invariants (200 cases)', () => {
  it.each(cases)('keeps generated recording coverage ordered and bounded: case %i', (index) => {
    const dayStart = new Date('2026-08-03T00:00:00.000Z');
    const dayEnd = new Date('2026-08-04T00:00:00.000Z');
    const firstStart = dayStart.getTime() + index * 20 * 60 * 1000;
    const firstEnd = firstStart + (300 + index) * 1000;
    const seamSeconds = index % 7;
    const secondStart = firstEnd + seamSeconds * 1000;
    const secondEnd = secondStart + (120 + index) * 1000;
    const spans: Span[] = [
      {
        startedAt: new Date(secondStart).toISOString(),
        endedAt: new Date(secondEnd).toISOString(),
      },
      {
        startedAt: new Date(firstStart).toISOString(),
        endedAt: new Date(firstEnd).toISOString(),
      },
    ];

    const result = mergeCoverage(spans, { cameraId: `cam-${index}`, dayStart, dayEnd });
    expect(result.coverageRatio).toBeGreaterThanOrEqual(0);
    expect(result.coverageRatio).toBeLessThanOrEqual(1);
    expect(result.recordedSeconds).toBeLessThanOrEqual(86_400);
    expect(result.gaps).toHaveLength(Math.max(0, result.runs.length - 1));
    for (let run = 1; run < result.runs.length; run += 1) {
      expect(Date.parse(result.runs[run - 1]!.endedAt)).toBeLessThan(
        Date.parse(result.runs[run]!.startedAt),
      );
    }
  });

  it.each(cases)('preserves AdGuard status precedence across reason variants: case %i', (index) => {
    const variant = index % 5;
    const [reason, expected] =
      variant === 0
        ? ([index % 2 === 0 ? 'NotFilteredNotFound' : 'NotFilteredWhiteList', 'allowed'] as const)
        : variant === 1
          ? ([index % 2 === 0 ? 'FilteredBlackList' : 'FilteredBlockedService', 'blocked'] as const)
          : variant === 2
            ? ([index % 2 === 0 ? 'Rewrite' : 'RewriteRule', 'rewritten'] as const)
            : variant === 3
              ? (['FilteredSafeSearch', 'safe_search'] as const)
              : ([`UpstreamError-${index}`, 'unknown'] as const);
    expect(mapQueryStatus(reason, false)).toBe(expected);
  });

  it.each(cases)(
    'redacts generated bearer credentials without leaking a suffix: case %i',
    (index) => {
      const credential = `Bearer eyJheader${index}.payload${index}.signature${index}`;
      const output = redactString(`authorization=${credential}; camera=front`);
      expect(output).toContain(REDACTED);
      expect(output).not.toContain(credential);
      expect(output).toContain('camera=front');
    },
  );

  it.each(cases)('mints bounded deterministic TURN credentials: case %i', (index) => {
    const now = new Date(1_800_000_000_000 + index * 1000);
    const config = {
      urls: ['turn:relay.example.test:3478?transport=udp'],
      staticAuthSecret: `test-secret-${index}`,
      credentialTtlSeconds: 60 + index,
    };
    const subject = `user:${index}/../device`;
    const first = mintTurnCredential(config, subject, now);
    const second = mintTurnCredential(config, subject, now);
    const expectedExpiry = Math.floor(now.getTime() / 1000) + config.credentialTtlSeconds;

    expect(first).toEqual(second);
    expect(first.username).toBe(`${expectedExpiry}:user${index}device`);
    expect(new Date(first.expiresAt).getTime()).toBe(expectedExpiry * 1000);
    expect(first.credential.length).toBeGreaterThan(20);
    expect(turnIceServers(config, subject, now)[0]?.credential).toBe(first.credential);
  });
});
