/**
 * Bridge provisioning end to end, without a Docker socket in sight.
 *
 * The applier is a shell script on a host; what is under test here is the half
 * that runs in the gateway — what it writes, what it will refuse to write, and
 * what it believes when something writes back. A real temp directory stands in
 * for the shared volume and the test plays the part of the applier, because the
 * file protocol *is* the contract between the two halves and mocking it away
 * would test nothing.
 *
 * The assertions that would be a real incident if they regressed:
 *
 *   - a request never names anything the caller chose
 *   - a credential travels outward only, and only the keys the provider declared
 *   - a status file cannot write arbitrary settings back onto a connection
 */
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { API_PREFIX, createHarness, type Harness } from '../helpers/harness.ts';

const SECRET_KEY = 'test-connections-key-that-is-long-enough-0001';

let harness: Harness | null = null;
let shared: string | null = null;

async function adminWithProvisioning(
  extra: Record<string, string> = {},
): Promise<{ h: Harness; token: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orionis-prov-'));
  shared = dir;
  const h = await createHarness({
    env: {
      CONNECTIONS_SECRET_KEY: SECRET_KEY,
      CONNECTIONS_PROVISIONING_DIR: dir,
      ...extra,
    },
  });
  harness = h;
  h.idp.groups = ['orionis-admins'];
  const tokens = await h.signIn();
  return { h, token: tokens.accessToken, dir };
}

/**
 * A Blink source that has already finished signing in — the account, the client
 * identity Blink verified, and the session token are all present, which is what
 * the store now requires before it will stand a bridge up. Never reaches the
 * network: nothing here probes successfully.
 */
const blink = (name: string, extraSettings: Record<string, unknown> = {}) => ({
  provider: 'lostblink',
  name,
  settings: {
    email: 'pat@example.invalid',
    tier: 'u011',
    accountId: 42,
    clientId: 7,
    userId: 99,
    uniqueId: 'stable-client-id',
    deviceIdentifier: 'Orionis Control',
    ...extraSettings,
  },
  secrets: { password: 'not-a-real-password', authToken: 'verified-session-token' },
});

async function create(h: Harness, token: string, body: Record<string, unknown>): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/connections`,
    headers: h.auth(token),
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.id as string;
}

async function provision(h: Harness, token: string, id: string) {
  return h.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/connections/${id}/provision`,
    headers: h.auth(token),
  });
}

/** Reads the single request the gateway wrote, as the applier would. */
async function readRequest(dir: string, connectionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(dir, 'requests', `${connectionId}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

/** Answers as the applier would, having done the work. */
async function writeStatus(
  dir: string,
  connectionId: string,
  status: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(dir, 'status'), { recursive: true });
  await writeFile(join(dir, 'status', `${connectionId}.json`), JSON.stringify(status));
  // The applier consumes the request once it has acted on it.
  await rm(join(dir, 'requests', `${connectionId}.json`), { force: true });
}

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (shared) await rm(shared, { recursive: true, force: true });
  shared = null;
});

describe('asking for a bridge', () => {
  it('writes a request naming the provider’s template, not the caller’s', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Front'));

    const res = await provision(h, token, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.provisioning.state).toBe('pending');

    const request = await readRequest(dir, id);
    // Every one of these is derived from the connection and the provider
    // descriptor. There is no field on this route a caller can put an image
    // name, a volume or a port into — which is the whole security argument.
    expect(request.template).toBe('lostblink');
    expect(request.action).toBe('create');
    expect(request.instance).toBe('blink-front');
    expect(request.connectionId).toBe(id);
  });

  it('hands over only the keys the provider declared, and no others', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    // The connection also holds an address the bridge *provides* for itself
    // (mediamtxApiUrl); that must never be handed back to it.
    const id = await create(
      h,
      token,
      blink('Blink Hall', { mediamtxApiUrl: 'http://elsewhere:9997' }),
    );
    await provision(h, token, id);

    const handover = (await readRequest(dir, id)).handover as Record<string, string>;
    expect(handover.email).toBe('pat@example.invalid');
    expect(handover.password).toBe('not-a-real-password');
    // The verified session, which is the whole reason a bridge waits for sign-in.
    expect(handover.authToken).toBe('verified-session-token');
    // Exactly the declared keys that are present — and not mediamtxApiUrl.
    expect(Object.keys(handover).sort()).toEqual(
      [
        'accountId',
        'authToken',
        'clientId',
        'deviceIdentifier',
        'email',
        'password',
        'tier',
        'uniqueId',
        'userId',
      ].sort(),
    );
    expect(handover.mediamtxApiUrl).toBeUndefined();
  });

  it('refuses to set up a bridge before the source has finished signing in', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    // Only the email and password have been entered — no verified session yet.
    const id = await create(h, token, {
      provider: 'lostblink',
      name: 'Blink Unverified',
      settings: { email: 'pat@example.invalid' },
      secrets: { password: 'not-a-real-password' },
    });

    const res = await provision(h, token, id);
    expect(res.statusCode, res.body).toBe(400);
    // Nothing was written to the shared directory: blinkpy is never booted with
    // bare credentials, which is what mailed a code on every start.
    await expect(readRequest(dir, id)).rejects.toThrow();
  });

  it('mints the bridge’s own credential rather than reading one back later', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, {
      provider: 'wyze',
      name: 'Wyze Yard',
      settings: {},
    });
    await provision(h, token, id);

    const handover = (await readRequest(dir, id)).handover as Record<string, string>;
    expect(handover.apiKey).toBeTruthy();

    // Held by the gateway at the same moment it was handed over, so nothing
    // secret ever has to travel back from the host.
    const after = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}`,
      headers: h.auth(token),
    });
    expect(after.json().data.secretsSet.apiKey).toBe(true);
    // Presence only — never the value.
    expect(after.body).not.toContain(handover.apiKey);
  });

  it('is idempotent: asking twice does not create a second bridge', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Twice'));

    const first = await provision(h, token, id);
    const second = await provision(h, token, id);

    expect(second.statusCode).toBe(200);
    expect(second.json().data.provisioning.requestId).toBe(
      first.json().data.provisioning.requestId,
    );
    expect((await readdir(join(dir, 'requests'))).length).toBe(1);
  });

  it('refuses a provider that needs no bridge', async () => {
    const { h, token } = await adminWithProvisioning();
    const id = await create(h, token, {
      provider: 'frigate',
      name: 'Frigate Main',
      settings: { baseUrl: 'http://frigate.invalid:5000' },
    });
    const res = await provision(h, token, id);
    expect(res.statusCode).toBe(501);
  });

  it('refuses once the instance ceiling is reached', async () => {
    const { h, token } = await adminWithProvisioning({ CONNECTIONS_MAX_BRIDGES: '1' });
    const first = await create(h, token, blink('Blink One'));
    const second = await create(h, token, blink('Blink Two'));

    expect((await provision(h, token, first)).statusCode).toBe(200);
    const res = await provision(h, token, second);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('limit');
  });

  it('reports unavailable rather than writing nowhere when no applier is configured', async () => {
    const h = await createHarness({ env: { CONNECTIONS_SECRET_KEY: SECRET_KEY } });
    harness = h;
    h.idp.groups = ['orionis-admins'];
    const token = (await h.signIn()).accessToken;

    const providers = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/providers`,
      headers: h.auth(token),
    });
    // The app hides the button on this, rather than offering something that
    // could only ever fail.
    expect(providers.json().data.provisioningAvailable).toBe(false);

    const id = await create(h, token, blink('Blink Nowhere'));
    const res = await provision(h, token, id);
    expect(res.statusCode).toBe(503);
  });

  it('is administrator-only, like everything else that holds credentials', async () => {
    const { h } = await adminWithProvisioning();
    h.idp.groups = ['orionis-operators'];
    const operator = (await h.signIn()).accessToken;
    const res = await provision(h, operator, 'conn_whatever');
    expect(res.statusCode).toBe(403);
  });
});

describe('what the host says back', () => {
  it('fills in the addresses the applier resolved', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Ready'));
    const requestId = (await provision(h, token, id)).json().data.provisioning.requestId;

    await writeStatus(dir, id, {
      id: requestId,
      connectionId: id,
      state: 'ready',
      message: 'The bridge is running.',
      updatedAt: new Date().toISOString(),
      settings: {
        mediamtxApiUrl: 'http://orionis-blink-ready-mediamtx:9997',
        rtspBaseUrl: 'rtsp://orionis-blink-ready-mediamtx:8554',
      },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}/provisioning`,
      headers: h.auth(token),
    });
    expect(res.json().data.provisioning.state).toBe('ready');

    const connection = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}`,
      headers: h.auth(token),
    });
    expect(connection.json().data.settings.mediamtxApiUrl).toBe(
      'http://orionis-blink-ready-mediamtx:9997',
    );
  });

  it('accepts only the settings the template said it provides', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Strict'));
    const requestId = (await provision(h, token, id)).json().data.provisioning.requestId;

    await writeStatus(dir, id, {
      id: requestId,
      connectionId: id,
      state: 'ready',
      message: 'Done.',
      updatedAt: new Date().toISOString(),
      settings: {
        mediamtxApiUrl: 'http://orionis-blink-strict-mediamtx:9997',
        // Not in the template's `provides`. The applier is trusted to run
        // containers, not to decide what else this connection means.
        email: 'attacker@example.invalid',
        tier: 'somewhere-else',
      },
    });

    await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}/provisioning`,
      headers: h.auth(token),
    });

    const settings = (
      await h.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/connections/${id}`,
        headers: h.auth(token),
      })
    ).json().data.settings;
    expect(settings.mediamtxApiUrl).toBe('http://orionis-blink-strict-mediamtx:9997');
    // The applier's attempts to rewrite settings outside the template's `provides`
    // are ignored: the signed-in values stand, the injected ones do not.
    expect(settings.email).toBe('pat@example.invalid');
    expect(settings.tier).toBe('u011');
  });

  it('refuses an address it would not have accepted from a person', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Metadata'));
    const requestId = (await provision(h, token, id)).json().data.provisioning.requestId;

    await writeStatus(dir, id, {
      id: requestId,
      connectionId: id,
      state: 'ready',
      message: 'Done.',
      updatedAt: new Date().toISOString(),
      settings: { mediamtxApiUrl: 'http://169.254.169.254/latest/meta-data' },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}/provisioning`,
      headers: h.auth(token),
    });
    expect(res.statusCode).toBe(400);

    // And the connection is untouched rather than half-updated.
    const settings = (
      await h.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/connections/${id}`,
        headers: h.auth(token),
      })
    ).json().data.settings;
    // Never written at all, rather than written and then noticed.
    expect(settings.mediamtxApiUrl).toBeUndefined();

    // And it is recorded as a failed setup, so the next poll reports the reason
    // rather than refusing identically forever.
    const after = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}/provisioning`,
      headers: h.auth(token),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().data.provisioning.state).toBe('failed');
    expect(after.json().data.provisioning.message).toContain('will not use');
  });

  it('ignores an answer to a request that is no longer the current one', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Stale'));
    await provision(h, token, id);

    // A leftover from a previous instance for this connection. Believing it
    // would report a torn-down container as ready.
    await writeStatus(dir, id, {
      id: 'prov_from_a_previous_life',
      connectionId: id,
      state: 'ready',
      message: 'Stale.',
      updatedAt: new Date().toISOString(),
      settings: { mediamtxApiUrl: 'http://stale:9997' },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}/provisioning`,
      headers: h.auth(token),
    });
    expect(res.json().data.provisioning.state).not.toBe('ready');

    const settings = (
      await h.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/connections/${id}`,
        headers: h.auth(token),
      })
    ).json().data.settings;
    expect(settings.mediamtxApiUrl).not.toBe('http://stale:9997');
  });

  it('shows the failure verbatim, because that line is the diagnosis', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Broken'));
    const requestId = (await provision(h, token, id)).json().data.provisioning.requestId;

    const reason =
      'orionis-blink-broken-lostblink stopped (exit 1). two-factor authentication required.';
    await writeStatus(dir, id, {
      id: requestId,
      connectionId: id,
      state: 'failed',
      message: reason,
      updatedAt: new Date().toISOString(),
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}/provisioning`,
      headers: h.auth(token),
    });
    expect(res.json().data.provisioning.state).toBe('failed');
    expect(res.json().data.provisioning.message).toBe(reason);
  });

  it('lets a failed attempt be retried', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Retry'));
    const first = (await provision(h, token, id)).json().data.provisioning.requestId;

    await writeStatus(dir, id, {
      id: first,
      connectionId: id,
      state: 'failed',
      message: 'No such image.',
      updatedAt: new Date().toISOString(),
    });
    await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/connections/${id}/provisioning`,
      headers: h.auth(token),
    });

    const retry = await provision(h, token, id);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.provisioning.requestId).not.toBe(first);
    expect(retry.json().data.provisioning.state).toBe('pending');
  });
});

describe('removing a source', () => {
  it('queues a teardown and says so', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Gone'));
    await provision(h, token, id);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/connections/${id}`,
      headers: { ...h.auth(token), 'x-confirm-disruptive': 'true' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.bridgeTeardownRequested).toBe(true);

    const request = await readRequest(dir, id);
    expect(request.action).toBe('remove');
    expect(request.instance).toBe('blink-gone');
    // A teardown carries no credential: there is nothing to sign in to.
    expect(request.handover).toBeUndefined();
  });

  it('leaves the bridge alone when asked to', async () => {
    const { h, token, dir } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Kept'));
    await provision(h, token, id);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/connections/${id}?keepBridge=true`,
      headers: { ...h.auth(token), 'x-confirm-disruptive': 'true' },
    });
    expect(res.json().data.bridgeTeardownRequested).toBe(false);
    // Still the original create request, not a teardown.
    expect((await readRequest(dir, id)).action).toBe('create');
  });

  it('still needs the disruptive confirmation, and says a bridge will stop', async () => {
    const { h, token } = await adminWithProvisioning();
    const id = await create(h, token, blink('Blink Careful'));
    await provision(h, token, id);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/connections/${id}`,
      headers: h.auth(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('bridge');
  });
});
