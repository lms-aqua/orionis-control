import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  mapInBatches,
  shouldDeliver,
  type NotificationPreferences,
  type PushMessage,
} from '../../src/notifications/push.ts';

describe('bounded notification fan-out', () => {
  it('starts at most four deliveries and preserves result order', async () => {
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const operation = async (value: number): Promise<number> => {
      started.push(value);
      await new Promise<void>((resolve) => releases.push(resolve));
      return value * 10;
    };

    const pending = mapInBatches([1, 2, 3, 4, 5], 4, operation);
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3, 4]);

    releases.splice(0).forEach((release) => release());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([1, 2, 3, 4, 5]);
    releases.splice(0).forEach((release) => release());
    await expect(pending).resolves.toEqual([10, 20, 30, 40, 50]);
  });

  it.each([0, -1, 1.5])('rejects invalid concurrency %s', async (concurrency) => {
    await expect(mapInBatches([1], concurrency, async (value) => value)).rejects.toThrow(
      RangeError,
    );
  });
});

const message = (overrides: Partial<PushMessage> = {}): PushMessage => ({
  kind: 'event.person',
  title: 'Person detected',
  body: 'Front Door',
  severity: 'warning',
  deepLink: 'orioniscontrol://event/evt-1',
  cameraId: 'cam-front',
  ...overrides,
});

const prefs = (overrides: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  ...structuredClone(DEFAULT_PREFERENCES),
  ...overrides,
});

describe('notification delivery decisions', () => {
  it('delivers by default', () => {
    expect(shouldDeliver(prefs(), message(), 12 * 60).deliver).toBe(true);
  });

  it('respects the global switch', () => {
    const result = shouldDeliver(prefs({ enabled: false }), message(), 12 * 60);
    expect(result).toEqual({ deliver: false, reason: 'notifications_disabled' });
  });

  it('respects a muted event kind', () => {
    const p = prefs();
    p.kinds['event.person'] = false;
    expect(shouldDeliver(p, message(), 12 * 60).reason).toBe('kind_muted');
  });

  it('respects a muted camera', () => {
    const p = prefs({ cameras: { 'cam-front': false } });
    expect(shouldDeliver(p, message(), 12 * 60).reason).toBe('camera_muted');
  });

  it('does not mute other cameras when one is muted', () => {
    const p = prefs({ cameras: { 'cam-front': false } });
    expect(shouldDeliver(p, message({ cameraId: 'cam-yard' }), 12 * 60).deliver).toBe(true);
  });

  it('applies the minimum severity threshold', () => {
    const p = prefs({ minimumSeverity: 'critical' });
    expect(shouldDeliver(p, message({ severity: 'warning' }), 12 * 60).reason).toBe(
      'below_minimum_severity',
    );
    expect(shouldDeliver(p, message({ severity: 'critical' }), 12 * 60).deliver).toBe(true);
  });

  describe('quiet hours', () => {
    const overnight = prefs({
      quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 },
    });

    it('suppresses inside an overnight window that wraps midnight', () => {
      expect(shouldDeliver(overnight, message(), 23 * 60).reason).toBe('quiet_hours');
      expect(shouldDeliver(overnight, message(), 2 * 60).reason).toBe('quiet_hours');
    });

    it('delivers outside the window', () => {
      expect(shouldDeliver(overnight, message(), 12 * 60).deliver).toBe(true);
      expect(shouldDeliver(overnight, message(), 7 * 60).deliver).toBe(true);
    });

    it('handles a same-day window', () => {
      const daytime = prefs({
        quietHours: { enabled: true, startMinute: 9 * 60, endMinute: 17 * 60 },
      });
      expect(shouldDeliver(daytime, message(), 10 * 60).reason).toBe('quiet_hours');
      expect(shouldDeliver(daytime, message(), 20 * 60).deliver).toBe(true);
    });

    it('lets critical alerts through when configured to bypass', () => {
      expect(shouldDeliver(overnight, message({ severity: 'critical' }), 23 * 60).deliver).toBe(
        true,
      );
    });

    it('holds critical alerts when bypass is off', () => {
      const strict = prefs({
        quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 },
        criticalBypassesQuietHours: false,
      });
      expect(shouldDeliver(strict, message({ severity: 'critical' }), 23 * 60).reason).toBe(
        'quiet_hours',
      );
    });

    it('is inclusive of the start minute and exclusive of the end minute', () => {
      const window = prefs({
        quietHours: { enabled: true, startMinute: 600, endMinute: 660 },
      });
      expect(shouldDeliver(window, message(), 600).reason).toBe('quiet_hours');
      expect(shouldDeliver(window, message(), 659).reason).toBe('quiet_hours');
      expect(shouldDeliver(window, message(), 660).deliver).toBe(true);
    });
  });
});
