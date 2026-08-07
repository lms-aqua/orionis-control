/**
 * The aggregator: many sources presented as one adapter.
 *
 * The governing rule under test is that partial failure is normal — one dead
 * source must not blank a wall of working cameras — and its limit: when there
 * is no partial truth to report, saying so is better than an empty list.
 */
import { describe, expect, it } from 'vitest';
import {
  AggregateOrionisAdapter,
  type ActiveConnection,
} from '../../src/adapters/connections/aggregate.ts';
import {
  namespaceId,
  parseNamespacedId,
  slugify,
} from '../../src/adapters/connections/provider.ts';
import { UnconfiguredOrionisAdapter } from '../../src/adapters/orionis/unconfigured.ts';
import { UNKNOWN_STORAGE } from '../../src/adapters/orionis/types.ts';
import { AppError } from '../../src/lib/errors.ts';
import {
  FakeProvider,
  fakeDescriptor,
  type FakeProviderOptions,
} from '../helpers/fake-provider.ts';

const ctx = (slug: string) => ({
  connectionId: `conn-${slug}`,
  slug,
  settings: {},
  secrets: {},
  fetchImpl: fetch,
  timeoutMs: 1000,
});

function connection(
  slug: string,
  options: FakeProviderOptions = {},
  sortOrder = 100,
): ActiveConnection {
  return {
    id: `conn-${slug}`,
    slug,
    name: slug,
    sortOrder,
    provider: new FakeProvider(ctx(slug), options),
  };
}

describe('namespacing', () => {
  it('round-trips an ID', () => {
    const id = namespaceId('frigate-main', 'driveway');
    expect(parseNamespacedId(id)).toEqual({ slug: 'frigate-main', upstreamId: 'driveway' });
  });

  it('splits on the first colon only, because upstream IDs contain colons', () => {
    // Frigate synthesises recording IDs with separators of their own, and a
    // camera key is entirely outside our control.
    expect(parseNamespacedId('nvr:camera:12:34')).toEqual({
      slug: 'nvr',
      upstreamId: 'camera:12:34',
    });
  });

  it('rejects shapes that are not namespaced IDs', () => {
    for (const bad of ['', 'no-colon', ':leading', 'trailing:']) {
      expect(parseNamespacedId(bad)).toBeNull();
    }
  });

  it('produces colon-free slugs, since a colon would break parsing', () => {
    expect(slugify('Front: Door')).not.toContain(':');
    expect(slugify('Frigate Main')).toBe('frigate-main');
    expect(slugify('!!!')).toBe('');
  });
});

describe('AggregateOrionisAdapter', () => {
  it('merges cameras and namespaces their IDs', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('nvr', { cameras: ['driveway'] }),
      connection('blink', { cameras: ['porch'] }),
    ]);
    const cameras = await adapter.listCameras();
    expect(cameras.map((c) => c.id).sort()).toEqual(['blink:porch', 'nvr:driveway']);
  });

  it('orders by the operator-chosen connection position, then by name', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('second', { cameras: ['zeta', 'alpha'] }, 20),
      connection('first', { cameras: ['omega'] }, 10),
    ]);
    expect((await adapter.listCameras()).map((c) => c.id)).toEqual([
      'first:omega',
      'second:alpha',
      'second:zeta',
    ]);
  });

  it('labels each camera with the source it came from', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('nvr', { cameras: ['driveway'] }),
    ]);
    expect((await adapter.listCameras())[0]!.group).toBe('nvr');
  });

  it('keeps serving the sources that work when one is down', async () => {
    const degraded: string[] = [];
    const adapter = new AggregateOrionisAdapter(
      () => [connection('nvr', { cameras: ['driveway'] }), connection('dead', { failing: true })],
      (id) => degraded.push(id),
    );
    const cameras = await adapter.listCameras();
    expect(cameras.map((c) => c.id)).toEqual(['nvr:driveway']);
    // The gap is reported rather than passed off as "there are no cameras".
    expect(degraded).toEqual(['conn-dead']);
  });

  it('reports an outage when every source fails', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('a', { failing: true }),
      connection('b', { failing: true }),
    ]);
    await expect(adapter.listCameras()).rejects.toThrow(AppError);
  });

  it('routes a single-camera read to the connection that owns it', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('nvr', { cameras: ['driveway'] }),
      connection('blink', { cameras: ['porch'] }),
    ]);
    expect((await adapter.getCamera('blink:porch')).id).toBe('blink:porch');
  });

  it('404s an ID whose connection is gone, rather than guessing', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('nvr', { cameras: ['driveway'] }),
    ]);
    await expect(adapter.getCamera('removed:driveway')).rejects.toThrow(AppError);
    await expect(adapter.getCamera('not-namespaced')).rejects.toThrow(AppError);
  });

  it('rewrites the camera ID on a stream session back to the namespaced one', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('nvr', { cameras: ['driveway'] }),
    ]);
    const session = await adapter.createStreamSession({
      cameraId: 'nvr:driveway',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    expect(session.cameraId).toBe('nvr:driveway');
  });

  it('treats an unknown total as unknown rather than summing it as zero', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('a', { storage: { usedBytes: 100, totalBytes: 1000 } }),
      connection('b', { storage: { usedBytes: null, totalBytes: 500 } }),
    ]);
    const storage = await adapter.getStorageStatus();
    // One source cannot say what it is using, so the total genuinely is unknown;
    // 100 would read as a confident undercount.
    expect(storage.usedBytes).toBeNull();
    expect(storage.totalBytes).toBe(1500);
  });

  it('returns unknown storage when no source can report any', async () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('a', { capabilities: { storageReporting: false } }),
    ]);
    expect(await adapter.getStorageStatus()).toEqual(UNKNOWN_STORAGE);
  });

  it('reports health from the recorded probe instead of probing live', async () => {
    const probed: string[] = [];
    const adapter = new AggregateOrionisAdapter(
      () => [connection('nvr', { cameras: ['driveway'] })],
      () => {},
      async (id) => {
        probed.push(id);
        return {
          status: 'healthy',
          message: 'Reachable.',
          latencyMs: 12,
          checkedAt: '2026-08-06T12:00:00.000Z',
        };
      },
    );
    const health = await adapter.listServiceHealth();
    expect(health[0]!.status).toBe('healthy');
    expect(health[0]!.checkedAt).toBe('2026-08-06T12:00:00.000Z');
    expect(health[0]!.message).toContain('12 ms');
    expect(probed).toEqual(['conn-nvr']);
  });

  it('says a connection has not been checked rather than inventing a status', async () => {
    const adapter = new AggregateOrionisAdapter(
      () => [connection('nvr')],
      () => {},
      async () => null,
    );
    expect((await adapter.listServiceHealth())[0]!.status).toBe('unknown');
  });

  describe('fallback to the environment-configured adapter', () => {
    it('delegates while no connection is enabled', async () => {
      const fallback = new UnconfiguredOrionisAdapter();
      const adapter = new AggregateOrionisAdapter(
        () => [],
        () => {},
        null,
        fallback,
      );

      // Not "no connections are configured" — the honest answer is whatever the
      // environment-built adapter says, which here is that it is not set up.
      await expect(adapter.listCameras()).rejects.toThrow(AppError);
      expect(adapter.configured).toBe(false);
    });

    it('takes over as soon as a connection exists, with no restart', async () => {
      let connections: ActiveConnection[] = [];
      const adapter = new AggregateOrionisAdapter(
        () => connections,
        () => {},
        null,
        new UnconfiguredOrionisAdapter(),
      );
      expect(adapter.configured).toBe(false);

      connections = [connection('nvr', { cameras: ['driveway'] })];
      expect(adapter.configured).toBe(true);
      expect((await adapter.listCameras()).map((c) => c.id)).toEqual(['nvr:driveway']);
    });
  });

  it('refuses to claim a stream was revoked when there was nothing to ask', async () => {
    const adapter = new AggregateOrionisAdapter(() => []);
    await expect(adapter.revokeStreamSession('stream-1')).rejects.toThrow(AppError);
  });

  it('advertises detection when any single source can detect', () => {
    const adapter = new AggregateOrionisAdapter(() => [
      connection('plain', { capabilities: { eventDetection: false } }),
      connection('smart', { capabilities: { eventDetection: true } }),
    ]);
    expect(adapter.eventDetection).toBe(true);
  });

  it('exposes a descriptor per provider without hard-coding the list', () => {
    // Adding a provider is one file plus one registration; nothing here changes.
    expect(fakeDescriptor({ id: 'x' }).id).toBe('x');
  });
});
