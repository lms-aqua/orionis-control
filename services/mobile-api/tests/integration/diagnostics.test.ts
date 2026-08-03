import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from '../helpers/harness.ts';
import { API_PREFIX, createHarness } from '../helpers/harness.ts';

const open: Harness[] = [];
afterEach(async () => Promise.all(open.splice(0).map((h) => h.close())));

const incident = {
  kind: 'webrtc_low_frame_rate',
  action: 'renegotiating',
  cameraId: 'front',
  transport: 'webrtc',
  occurredAt: '2026-08-03T18:00:00.000Z',
  metrics: {
    framesPerSecond: 1,
    baselineFramesPerSecond: 20,
    staleSeconds: 0.4,
    resolution: '1920x1080',
    connectionAttempts: 1,
    reconnectCount: 1,
    stallCount: 1,
  },
  context: { lowData: false, lowPowerMode: false, thermalState: 'nominal' },
};

describe('client media incidents', () => {
  it('requires authentication', async () => {
    const h = await createHarness();
    open.push(h);
    const response = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/diagnostics/incidents`,
      payload: incident,
    });
    expect(response.statusCode).toBe(401);
  });

  it('stores a readable, actor-bound incident in the redacted audit log', async () => {
    const h = await createHarness();
    open.push(h);
    h.idp.groups = ['orionis-viewers'];
    const tokens = await h.signIn();
    const response = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/diagnostics/incidents`,
      headers: h.auth(tokens.accessToken),
      payload: incident,
    });
    expect(response.statusCode).toBe(200);

    const records = h.services.audit.list({
      limit: 10,
      offset: 0,
      action: 'client.media.incident_reported',
    });
    expect(records.total).toBe(1);
    expect(records.items[0]).toMatchObject({
      action: 'client.media.incident_reported',
      deviceId: 'test-device-0001',
      targetType: 'camera',
      targetId: 'front',
      outcome: 'failure',
    });
    expect(records.items[0]!.reason).toContain('webrtc low frame rate');
    expect(records.items[0]!.metadata).toMatchObject(incident);
  });

  it('rejects arbitrary messages and out-of-range metrics', async () => {
    const h = await createHarness();
    open.push(h);
    const tokens = await h.signIn();
    const response = await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/diagnostics/incidents`,
      headers: h.auth(tokens.accessToken),
      payload: {
        ...incident,
        rawError: 'Bearer should-never-be-accepted',
        metrics: { ...incident.metrics, framesPerSecond: 999 },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      h.services.audit.list({ limit: 10, offset: 0, action: 'client.media.incident_reported' })
        .total,
    ).toBe(0);
  });

  it('lets an administrator read incidents through the audit API', async () => {
    const h = await createHarness();
    open.push(h);
    const tokens = await h.signIn();
    await h.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/diagnostics/incidents`,
      headers: h.auth(tokens.accessToken),
      payload: incident,
    });

    const response = await h.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/audit?action=client.media.incident_reported&limit=10`,
      headers: h.auth(tokens.accessToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items[0]).toMatchObject({
      action: 'client.media.incident_reported',
      targetId: 'front',
      metadata: incident,
    });
  });
});
