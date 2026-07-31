/**
 * Server-side authorisation. These tests exist because hiding a control in the
 * iOS app is presentation, not security — the gateway must refuse regardless.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { API_PREFIX, createHarness, type Harness } from '../helpers/harness.ts';
import { StubAdGuardAdapter, StubOrionisAdapter } from '../helpers/stub-adapters.ts';

let harness: Harness | null = null;

async function signedInAs(
  group: 'orionis-viewers' | 'orionis-operators' | 'orionis-admins',
): Promise<{
  h: Harness;
  token: string;
  orionis: StubOrionisAdapter;
  adguard: StubAdGuardAdapter;
}> {
  const orionis = new StubOrionisAdapter();
  const adguard = new StubAdGuardAdapter();
  const h = await createHarness({ orionis, adguard });
  harness = h;
  h.idp.groups = [group];
  const tokens = await h.signIn();
  return { h, token: tokens.accessToken, orionis, adguard };
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('viewer', () => {
  it('may read cameras, events, AdGuard and system health', async () => {
    const { h, token } = await signedInAs('orionis-viewers');
    for (const path of [
      '/cameras',
      '/events',
      '/adguard/status',
      '/system/services',
      '/dashboard',
    ]) {
      const res = await h.app.inject({
        method: 'GET',
        url: `${API_PREFIX}${path}`,
        headers: h.auth(token),
      });
      expect([200], `${path} returned ${res.statusCode}`).toContain(res.statusCode);
    }
  });

  it('may not pause DNS protection', async () => {
    const { h, token, adguard } = await signedInAs('orionis-viewers');
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/protection`,
      headers: { ...h.auth(token), 'x-confirm-disruptive': 'true' },
      payload: { enabled: false, durationSeconds: 300 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INSUFFICIENT_ROLE');
    // The upstream must never have been touched.
    expect(adguard.protectionCalls).toHaveLength(0);
    expect(adguard.protectionEnabled).toBe(true);
  });

  it('may not move a camera', async () => {
    const { h, token, orionis } = await signedInAs('orionis-viewers');
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/controls`,
      headers: h.auth(token),
      payload: { action: 'ptz', direction: 'left' },
    });
    expect(res.statusCode).toBe(403);
    expect(orionis.controlCalls).toHaveLength(0);
  });

  it('may not acknowledge an event', async () => {
    const { h, token } = await signedInAs('orionis-viewers');
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/events/evt-1/acknowledge`,
      headers: h.auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('may not read the audit log', async () => {
    const { h, token } = await signedInAs('orionis-viewers');
    const res = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/audit`,
      headers: h.auth(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('may not run a system action', async () => {
    const { h, token } = await signedInAs('orionis-viewers');
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/system/actions`,
      headers: h.auth(token),
      payload: { actionId: 'health.recheck' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('operator', () => {
  it('may pan a camera and acknowledge events', async () => {
    const { h, token, orionis } = await signedInAs('orionis-operators');

    const ptz = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/controls`,
      headers: h.auth(token),
      payload: { action: 'ptz', direction: 'left', speed: 0.5 },
    });
    expect(ptz.statusCode).toBe(200);
    expect(orionis.controlCalls).toHaveLength(1);

    const ack = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/events/evt-1/acknowledge`,
      headers: h.auth(token),
      payload: { note: 'Checked, it was the postman.' },
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().data.acknowledged).toBe(true);
  });

  it('may pause protection but may not write filtering rules', async () => {
    const { h, token, adguard } = await signedInAs('orionis-operators');

    const pause = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/protection`,
      headers: { ...h.auth(token), 'x-confirm-disruptive': 'true' },
      payload: { enabled: false, durationSeconds: 600, reason: 'Debugging a device.' },
    });
    expect(pause.statusCode).toBe(200);
    expect(adguard.protectionCalls[0]?.durationSeconds).toBe(600);

    const rule = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers: h.auth(token),
      payload: { rule: 'example.invalid', kind: 'block' },
    });
    expect(rule.statusCode).toBe(403);
  });

  it('may not restart a camera or trigger the siren', async () => {
    const { h, token, orionis } = await signedInAs('orionis-operators');
    for (const action of ['restart', 'siren']) {
      const res = await h.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/cameras/cam-front/controls`,
        headers: { ...h.auth(token), 'x-confirm-disruptive': 'true' },
        payload: { action, value: true },
      });
      expect(res.statusCode, `${action} should be denied`).toBe(403);
    }
    expect(orionis.controlCalls).toHaveLength(0);
  });
});

describe('administrator', () => {
  it('may write rules, run actions and read the audit log', async () => {
    const { h, token } = await signedInAs('orionis-admins');

    const rule = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/rules`,
      headers: h.auth(token),
      payload: { rule: 'tracker.invalid', kind: 'block' },
    });
    expect(rule.statusCode).toBe(200);
    expect(rule.json().data.rule).toBe('||tracker.invalid^');

    const action = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/system/actions`,
      headers: h.auth(token),
      payload: { actionId: 'health.recheck' },
    });
    expect(action.statusCode).toBe(200);
    expect(action.json().data.ok).toBe(true);

    const audit = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/audit`,
      headers: h.auth(token),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.items.length).toBeGreaterThan(0);
  });
});

describe('capability gating', () => {
  it('refuses a control the camera does not advertise, even for an administrator', async () => {
    const { h, token, orionis } = await signedInAs('orionis-admins');
    // The stub camera advertises no siren.
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/controls`,
      headers: { ...h.auth(token), 'x-confirm-disruptive': 'true' },
      payload: { action: 'siren', value: true },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(orionis.controlCalls).toHaveLength(0);
  });
});

describe('disruptive-action confirmation', () => {
  it('requires an explicit confirmation header before restarting a camera', async () => {
    const { h, token, orionis } = await signedInAs('orionis-admins');

    const unconfirmed = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/controls`,
      headers: h.auth(token),
      payload: { action: 'restart' },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.details.requiresHeader).toContain('X-Confirm-Disruptive');
    expect(orionis.controlCalls).toHaveLength(0);

    const confirmed = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/cameras/cam-front/controls`,
      headers: { ...h.auth(token), 'x-confirm-disruptive': 'true' },
      payload: { action: 'restart' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(orionis.controlCalls).toHaveLength(1);
  });

  it('requires confirmation before changing DNS protection', async () => {
    const { h, token, adguard } = await signedInAs('orionis-admins');
    const res = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/adguard/protection`,
      headers: h.auth(token),
      payload: { enabled: false, durationSeconds: 300 },
    });
    expect(res.statusCode).toBe(400);
    expect(adguard.protectionCalls).toHaveLength(0);
  });
});
