/**
 * The connections API end to end.
 *
 * A connection holds someone else's credentials and decides what the gateway
 * will fetch, so the things asserted here are the ones that would be a real
 * incident if they regressed: who may reach these routes at all, that a stored
 * credential never comes back out, and that a dangerous address is refused.
 *
 * The RTSP provider in manual mode is used throughout because it needs no
 * network — the routes, not the upstreams, are what is under test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { API_PREFIX, createHarness, type Harness } from '../helpers/harness.ts';

const SECRET_KEY = 'test-connections-key-that-is-long-enough-0001';

let harness: Harness | null = null;

async function signedInAs(
  group: 'orionis-viewers' | 'orionis-operators' | 'orionis-admins',
  env: Record<string, string> = {},
): Promise<{ h: Harness; token: string }> {
  const h = await createHarness({ env: { CONNECTIONS_SECRET_KEY: SECRET_KEY, ...env } });
  harness = h;
  h.idp.groups = [group];
  const tokens = await h.signIn();
  return { h, token: tokens.accessToken };
}

/** A source that resolves without touching the network. */
const manualRtsp = (name: string) => ({
  provider: 'rtsp',
  name,
  settings: { mode: 'manual', streams: 'front_door=rtsp://mediamtx:8554/front_door' },
});

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('authorisation', () => {
  it('refuses an unauthenticated caller', async () => {
    const h = await createHarness({ env: { CONNECTIONS_SECRET_KEY: SECRET_KEY } });
    harness = h;
    const res = await h.app.inject({ method: 'GET', url: `${API_PREFIX}/connections` });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a viewer', async () => {
    const { h, token } = await signedInAs('orionis-viewers');
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an operator — credentials for another system are not theirs to hold', async () => {
    const { h, token } = await signedInAs('orionis-operators');
    for (const [method, url] of [
      ['GET', '/connections'],
      ['GET', '/connections/providers'],
      ['POST', '/connections'],
    ] as const) {
      const res = await h.app.inject({
        method,
        url: `${API_PREFIX}${url}`,
        headers: h.auth(token),
        payload: method === 'POST' ? manualRtsp('Nope') : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('allows an administrator', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('feature gate', () => {
  it('reports the feature as unconfigured when no encryption key is set', async () => {
    // Storing third-party credentials without a key would mean storing them in
    // the clear, so the feature turns off rather than degrading.
    const { h, token } = await signedInAs('orionis-admins', { CONNECTIONS_SECRET_KEY: '' });
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVICE_NOT_CONFIGURED');
  });
});

describe('providers', () => {
  it('describes what can be added and which fields each needs', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/providers`,
      headers: h.auth(token),
    });
    expect(res.statusCode).toBe(200);

    const providers = res.json().data.providers as {
      id: string;
      fields: { key: string; type: string }[];
      capabilities: Record<string, boolean>;
    }[];
    expect(providers.map((p) => p.id).sort()).toEqual([
      'frigate',
      'lostblink',
      'nest',
      'rtsp',
      'tapo',
      'unifi',
      'wyze',
    ]);

    // The app renders its form from this, so every provider must describe its
    // fields and its capabilities rather than leaving the app to guess.
    for (const provider of providers) {
      expect(provider.fields.length, provider.id).toBeGreaterThan(0);
      expect(typeof provider.capabilities.liveStream, provider.id).toBe('boolean');
    }
  });
});

describe('lifecycle', () => {
  it('creates, reads, updates and removes a connection', async () => {
    const { h, token } = await signedInAs('orionis-admins');

    const created = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: manualRtsp('Front Door'),
    });
    expect(created.statusCode).toBe(200);
    const record = created.json().data;
    expect(record.slug).toBe('front-door');
    // Created and probed in one step, so an operator is not left guessing
    // whether what they just saved works.
    expect(record.health.status).toBe('healthy');

    const read = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${record.id}`,
      headers: h.auth(token),
    });
    expect(read.json().data.name).toBe('Front Door');

    const updated = await h.app.inject({
      method: 'PATCH',
      url: `${API_PREFIX}/connections/${record.id}`,
      headers: h.auth(token),
      payload: { name: 'Porch' },
    });
    expect(updated.json().data.name).toBe('Porch');
    // The slug is what every camera ID it has handed out is built from.
    expect(updated.json().data.slug).toBe('front-door');

    const removed = await h.app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/connections/${record.id}`,
      headers: h.auth(token),
    });
    expect(removed.statusCode).toBe(200);

    const gone = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${record.id}`,
      headers: h.auth(token),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('refuses a second connection whose identifier would collide', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: manualRtsp('Front Door'),
    });
    const clash = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: manualRtsp('front door'),
    });
    expect(clash.statusCode).toBe(409);
  });

  it('rejects a connection missing a field its provider requires', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: { provider: 'frigate', name: 'Frigate' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('probes on demand and records the result', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    const created = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: manualRtsp('Front Door'),
    });
    const id = created.json().data.id;

    const probe = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections/${id}/probe`,
      headers: h.auth(token),
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().data.health.status).toBe('healthy');
  });
});

describe('credentials', () => {
  it('never returns a stored credential, only which keys are set', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    const created = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: {
        provider: 'frigate',
        name: 'Frigate',
        settings: { baseUrl: 'http://frigate:5000' },
        secrets: { apiKey: 'do-not-leak-this' },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain('do-not-leak-this');
    expect(created.json().data.secretsSet).toEqual({ apiKey: true });

    const listed = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
    });
    expect(listed.body).not.toContain('do-not-leak-this');
  });
});

describe('upstream addresses', () => {
  it('refuses an address that would aim the gateway at cloud metadata', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: {
        provider: 'frigate',
        name: 'Metadata',
        settings: { baseUrl: 'http://169.254.169.254/latest/meta-data/' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a scheme the gateway should never fetch', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: { provider: 'frigate', name: 'Local', settings: { baseUrl: 'file:///etc/hosts' } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('interactive sign-in', () => {
  it('reports that a provider without interactive sign-in has none', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    const created = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: manualRtsp('Front Door'),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections/${created.json().data.id}/auth/begin`,
      headers: h.auth(token),
    });
    expect(res.statusCode).toBe(501);
  });
});

describe('audit', () => {
  it('records who added a connection, without its settings or credentials', async () => {
    const { h, token } = await signedInAs('orionis-admins');
    await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/connections`,
      headers: h.auth(token),
      payload: {
        provider: 'frigate',
        name: 'Frigate',
        settings: { baseUrl: 'http://frigate:5000' },
        secrets: { apiKey: 'do-not-leak-this' },
      },
    });

    const audit = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/audit`,
      headers: h.auth(token),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).toContain('connection.created');
    expect(audit.body).not.toContain('do-not-leak-this');
  });
});
