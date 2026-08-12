import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildProviderRegistry } from '../../src/adapters/connections/index.ts';

const TEMPLATE_DIR = fileURLToPath(new URL('../../../provisioner/templates/', import.meta.url));

const descriptors = buildProviderRegistry().descriptors();
const withBridge = descriptors.filter((d) => d.bridge);

describe('every declared bridge template exists', () => {
  // Ring, Eufy and Arlo each shipped naming a template that was never written.
  // The applier validates the name against the files on disk and refuses what
  // it does not recognise — *before* it writes a status — so the app was left
  // with no state to render at all. Silent, and invisible from either side
  // until someone tried to add one of those three.
  it.each(withBridge.map((d) => [d.id, d.bridge!.template]))(
    '%s declares template %s',
    (_id, template) => {
      expect(existsSync(`${TEMPLATE_DIR}${template}.yml`)).toBe(true);
    },
  );

  it('checks at least the providers known to need one', () => {
    // Guards the guard: if descriptors() ever returns nothing, the loop above
    // passes vacuously and this test is worthless.
    expect(withBridge.map((d) => d.id).sort()).toEqual(
      ['eufy', 'lostblink', 'ring', 'rtsp', 'wyze'].sort(),
    );
  });
});

describe('a bridge that signs in has something to sign in with', () => {
  // The Blink outage: `refreshToken` and `hardwareId` were captured and stored
  // but never declared, so `resolveHandover` dropped them and the bridge fell
  // back to a full login. A key named here that no code path fills is the same
  // failure one step earlier — the template gets a blank where a credential
  // should be, and reports a sign-in problem nobody can act on.
  it('names the account keys each bridge needs', () => {
    const handsOver = Object.fromEntries(
      withBridge.map((d) => [
        d.id,
        [...(d.bridge?.handsOver?.settings ?? []), ...(d.bridge?.handsOver?.secrets ?? [])],
      ]),
    );

    // ring-mqtt would otherwise run its own browser sign-in on a port this
    // deployment does not publish.
    expect(handsOver.ring).toContain('refreshToken');
    // eufy-security-ws signs in to Eufy itself and holds no account of its own.
    expect(handsOver.eufy).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('only hands over keys the provider actually declares as fields', () => {
    for (const descriptor of withBridge) {
      const declared = new Set(descriptor.fields.map((f) => f.key));
      const handed = [
        ...(descriptor.bridge?.handsOver?.settings ?? []),
        ...(descriptor.bridge?.handsOver?.secrets ?? []),
      ];
      for (const key of handed) {
        // Blink is the exception: its handover carries values the OAuth2 flow
        // captures rather than anything an operator types.
        if (descriptor.id === 'lostblink') continue;
        expect(declared, `${descriptor.id} hands over "${key}"`).toContain(key);
      }
    }
  });
});

describe('Arlo asks for an address rather than offering to start one', () => {
  // arlo-cam-api replaces the base station: hostapd, dnsmasq, a WiFi adapter,
  // and physical presence on the cameras' network. Nothing this applier can
  // start, so declaring a bridge only hid the address field behind an offer
  // that could never be honoured.
  it('declares no bridge', () => {
    expect(descriptors.find((d) => d.id === 'arlo')?.bridge).toBeUndefined();
  });

  it('still asks where the bridge is', () => {
    const arlo = descriptors.find((d) => d.id === 'arlo');
    expect(arlo?.fields.map((f) => f.key)).toContain('baseUrl');
  });
});
