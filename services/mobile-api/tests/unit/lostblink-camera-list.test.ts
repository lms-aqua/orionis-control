import { describe, expect, it } from 'vitest';

import { LostblinkProvider } from '../../src/adapters/connections/providers/lostblink.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

/**
 * A MediaMTX that answers `/v3/paths/list` with whatever the caller queues.
 *
 * The queue is the point: a Blink camera publishes in bursts, so consecutive
 * polls legitimately see different paths — including none at all.
 */
function ctxWithPaths(connectionId: string, responses: string[][]): ProviderContext {
  let call = 0;
  return {
    connectionId,
    slug: 'blink',
    settings: { mediamtxApiUrl: 'http://mediamtx.invalid:9997' },
    secrets: {},
    fetchImpl: (async () => {
      const names = responses[Math.min(call++, responses.length - 1)] ?? [];
      return new Response(JSON.stringify({ items: names.map((name) => ({ name, ready: true })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
    timeoutMs: 1000,
  };
}

describe('the camera list survives the gap between live sessions', () => {
  it('keeps a camera that has stopped publishing, reported offline', async () => {
    // Blink caps a live session at 300s. A poll landing between two sessions
    // sees no paths, and returning nothing there emptied the whole wall.
    const provider = new LostblinkProvider(ctxWithPaths('conn-gap', [['driveway', 'road'], []]));

    const first = await provider.listCameras();
    expect(first.map((c) => c.id).sort()).toEqual(['driveway', 'road']);
    expect(first.every((c) => c.health.status === 'online')).toBe(true);

    const duringGap = await provider.listCameras();
    expect(duringGap.map((c) => c.id).sort()).toEqual(['driveway', 'road']);
    // Present, and honest about not currently streaming.
    expect(duringGap.every((c) => c.health.status !== 'online')).toBe(true);
  });

  it('accumulates cameras seen across separate bursts', async () => {
    // Two cameras rarely publish at the same instant, so a single poll is not
    // the whole roster.
    const provider = new LostblinkProvider(
      ctxWithPaths('conn-burst', [['driveway'], ['road'], []]),
    );

    await provider.listCameras();
    await provider.listCameras();
    const third = await provider.listCameras();

    expect(third.map((c) => c.id).sort()).toEqual(['driveway', 'road']);
  });

  it('opens a camera that is between sessions instead of 404ing it', async () => {
    // The tile was on screen a moment ago; "not found" for something the user
    // can plainly see is the wrong answer.
    const provider = new LostblinkProvider(ctxWithPaths('conn-open', [['driveway'], []]));

    await provider.listCameras();
    const camera = await provider.getCamera('driveway');

    expect(camera.id).toBe('driveway');
    expect(camera.health.status).not.toBe('online');
  });

  it('still refuses a camera it has never seen', async () => {
    const provider = new LostblinkProvider(ctxWithPaths('conn-unknown', [['driveway']]));
    await provider.listCameras();

    await expect(provider.getCamera('nonexistent')).rejects.toThrow();
  });

  it('does not leak remembered cameras between connections', async () => {
    const a = new LostblinkProvider(ctxWithPaths('conn-a', [['driveway']]));
    await a.listCameras();

    const b = new LostblinkProvider(ctxWithPaths('conn-b', [[]]));
    expect(await b.listCameras()).toEqual([]);
  });
});
