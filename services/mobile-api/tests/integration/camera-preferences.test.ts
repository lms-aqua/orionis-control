/**
 * Favourites and camera order belong to the account, not the handset.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { API_PREFIX, createHarness, type Harness } from '../helpers/harness.ts';
import { StubAdGuardAdapter, StubOrionisAdapter } from '../helpers/stub-adapters.ts';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function setUp() {
  const orionis = new StubOrionisAdapter();
  harness = await createHarness({ orionis, adguard: new StubAdGuardAdapter() });
  const tokens = await harness.signIn();
  return { orionis, tokens };
}

describe('camera preferences', () => {
  it('starts with no favourites and every camera in a stable order', async () => {
    const { tokens } = await setUp();
    const res = await harness!.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.favouriteIds).toEqual([]);
    expect(data.order).toEqual(['cam-front', 'cam-yard']);
  });

  it('persists favourites and a custom order', async () => {
    const { tokens } = await setUp();
    const saved = await harness!.app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
      payload: { favouriteIds: ['cam-yard'], order: ['cam-yard', 'cam-front'] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.order).toEqual(['cam-yard', 'cam-front']);

    const reread = await harness!.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
    });
    expect(reread.json().data.favouriteIds).toEqual(['cam-yard']);
    expect(reread.json().data.order).toEqual(['cam-yard', 'cam-front']);
  });

  it('follows the account to another device', async () => {
    const { tokens } = await setUp();
    await harness!.app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
      payload: { favouriteIds: ['cam-front'] },
    });

    // A second sign-in from a different device is the same person.
    const second = await harness!.signIn({ deviceId: 'second-device-0002' });
    const res = await harness!.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(second.accessToken),
    });
    expect(res.json().data.favouriteIds).toEqual(['cam-front']);
  });

  it('leaves the other list alone when only one is sent', async () => {
    const { tokens } = await setUp();
    await harness!.app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
      payload: { favouriteIds: ['cam-front'], order: ['cam-yard', 'cam-front'] },
    });
    // Update only the favourites.
    const res = await harness!.app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
      payload: { favouriteIds: [] },
    });
    expect(res.json().data.favouriteIds).toEqual([]);
    expect(res.json().data.order).toEqual(['cam-yard', 'cam-front']);
  });

  it('drops ids for cameras that no longer exist', async () => {
    const { orionis, tokens } = await setUp();
    await harness!.app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
      payload: { favouriteIds: ['cam-front', 'cam-yard'] },
    });

    // The camera is removed upstream; it must not linger in the list forever.
    orionis.cameras = orionis.cameras.filter((c) => c.id !== 'cam-yard');
    const res = await harness!.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
    });
    expect(res.json().data.favouriteIds).toEqual(['cam-front']);
    expect(res.json().data.order).toEqual(['cam-front']);
  });

  it('never lets a stored order hide a camera that exists', async () => {
    const { orionis, tokens } = await setUp();
    await harness!.app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
      payload: { order: ['cam-yard'] },
    });

    // A camera added after the order was saved must still appear.
    orionis.cameras = [...orionis.cameras, { ...orionis.cameras[0]!, id: 'cam-new' }];
    const res = await harness!.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
    });
    expect(res.json().data.order).toContain('cam-new');
    expect(res.json().data.order[0]).toBe('cam-yard');
  });

  it('ignores unknown ids rather than storing them', async () => {
    const { tokens } = await setUp();
    const res = await harness!.app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
      payload: { favouriteIds: ['cam-front', 'does-not-exist'] },
    });
    expect(res.json().data.favouriteIds).toEqual(['cam-front']);
  });

  it('de-duplicates a repeated id', async () => {
    const { tokens } = await setUp();
    const res = await harness!.app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/cameras/preferences`,
      headers: harness!.auth(tokens.accessToken),
      payload: { favouriteIds: ['cam-front', 'cam-front'] },
    });
    expect(res.json().data.favouriteIds).toEqual(['cam-front']);
  });
});
