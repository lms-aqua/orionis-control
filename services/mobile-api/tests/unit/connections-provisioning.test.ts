/**
 * The pure parts of provisioning: what leaves the gateway, what it accepts back,
 * and the descriptor change that let a Blink connection be saved at all.
 *
 * These are unit tests because both filters are one function each, and both are
 * the kind of function whose failure is silent — a handover that carries one key
 * too many, or a status file that writes a setting nobody declared, would look
 * exactly like success.
 */
import { describe, expect, it } from 'vitest';
import { buildProviderRegistry } from '../../src/adapters/connections/index.ts';
import {
  acceptProvidedSettings,
  resolveHandover,
} from '../../src/adapters/connections/provisioning.ts';
import { isValidInstanceName } from '../../src/lib/provisioning.ts';
import type { ProviderBridge } from '../../src/adapters/connections/provider.ts';

const registry = buildProviderRegistry();

describe('the lostblink descriptor', () => {
  const descriptor = registry.descriptor('lostblink');

  it('asks for the account before the plumbing', () => {
    // The original complaint: the form demanded two container addresses before
    // it would accept a Blink email. Order is the order they are asked for.
    expect(descriptor?.fields.map((f) => f.key).slice(0, 2)).toEqual(['email', 'password']);
  });

  it('requires only what the person actually knows', () => {
    const required = descriptor?.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(['email', 'password']);
  });

  it('defaults the bridge addresses instead of demanding them', () => {
    for (const key of ['mediamtxApiUrl', 'rtspBaseUrl']) {
      const field = descriptor?.fields.find((f) => f.key === key);
      expect(field?.required, key).toBe(false);
      expect(field?.advanced, key).toBe(true);
      // A default means the box is never actually empty, so "optional" does not
      // turn into "unconfigured".
      expect(field?.default, key).toBeTruthy();
    }
  });

  it('never hides a field somebody has to fill in', () => {
    // An advanced *required* field is a form that refuses to save with no
    // visible reason. Asserted across every provider, not just this one.
    for (const provider of registry.descriptors()) {
      for (const field of provider.fields) {
        expect(field.advanced === true && field.required, `${provider.id}.${field.key}`).toBe(
          false,
        );
      }
    }
  });
});

describe('the Blink session handed to lostblink', () => {
  const bridge = registry.descriptor('lostblink')?.bridge;

  it('carries every field blinkpy needs to skip signing in again', () => {
    // blinkpy 0.23 `Auth.startup()` refreshes the token if **any** value in its
    // saved credentials is None. A handover missing one of these does not
    // degrade — it puts the bridge straight back at a fresh login and a
    // verification code sent to a console nobody is watching. The applier's
    // `seed_lostblink_credentials` maps these onto blinkpy's own key names.
    const handed = [...(bridge?.handsOver?.settings ?? []), ...(bridge?.handsOver?.secrets ?? [])];
    for (const key of [
      'email', // → username
      'password',
      'authToken', // → token
      'tier', // → region_id, and host
      'accountId',
      'clientId',
      'userId',
      'uniqueId', // → uid: the client identity Blink verified
      'deviceIdentifier', // → device_id, same
    ]) {
      expect(handed, key).toContain(key);
    }
  });

  it('sends the session as a secret, not as a setting', () => {
    // A Blink token is full account access. Storing it beside the region tier
    // would put it in every API response that returns settings.
    expect(bridge?.handsOver?.secrets).toContain('authToken');
    expect(bridge?.handsOver?.settings ?? []).not.toContain('authToken');
  });
});

describe('every declared bridge', () => {
  it('names settings the provider actually has', () => {
    // A `provides` key with no matching field would be hidden from a form it
    // never appeared in, and written back to a setting nothing reads.
    for (const provider of registry.descriptors()) {
      const bridge = provider.bridge;
      if (!bridge) continue;
      const keys = new Set(provider.fields.map((f) => f.key));
      for (const key of bridge.provides) {
        expect(keys.has(key), `${provider.id}.bridge.provides:${key}`).toBe(true);
      }
      for (const key of bridge.mints ?? []) {
        expect(keys.has(key), `${provider.id}.bridge.mints:${key}`).toBe(true);
      }
    }
  });
});

describe('handover', () => {
  const bridge: ProviderBridge = {
    template: 'lostblink',
    summary: 'x',
    provides: ['mediamtxApiUrl'],
    handsOver: { settings: ['email'], secrets: ['password'] },
    mints: ['apiKey'],
  };

  it('carries exactly the declared keys and nothing else', () => {
    const out = resolveHandover(
      bridge,
      { email: 'pat@example.invalid', tier: 'rest-prod', accountId: 42 },
      { password: 'secret', authToken: 'must-not-travel' },
      { apiKey: 'minted' },
    );
    expect(out).toEqual({ email: 'pat@example.invalid', password: 'secret', apiKey: 'minted' });
  });

  it('omits a declared key the connection does not hold', () => {
    // Absent rather than empty: the applier's template decides whether that is
    // fatal, and an empty string would look like a deliberate blank password.
    const out = resolveHandover(bridge, {}, {}, {});
    expect(out).toEqual({});
  });

  it('sends nothing at all for a template that declared nothing', () => {
    const out = resolveHandover(
      { template: 'go2rtc', summary: 'x', provides: ['baseUrl'] },
      { email: 'pat@example.invalid' },
      { password: 'secret' },
      {},
    );
    expect(out).toEqual({});
  });
});

describe('what comes back', () => {
  const bridge: ProviderBridge = {
    template: 'lostblink',
    summary: 'x',
    provides: ['mediamtxApiUrl', 'rtspBaseUrl'],
  };

  it('takes only the settings the template said it provides', () => {
    expect(
      acceptProvidedSettings(bridge, {
        mediamtxApiUrl: 'http://m:9997',
        email: 'attacker@example.invalid',
      }),
    ).toEqual({ mediamtxApiUrl: 'http://m:9997' });
  });

  it('drops anything that is not a non-empty string', () => {
    expect(
      acceptProvidedSettings(bridge, {
        mediamtxApiUrl: '   ',
        rtspBaseUrl: { toString: () => 'rtsp://sneaky' },
      }),
    ).toEqual({});
  });

  it('treats a missing settings block as nothing to apply', () => {
    expect(acceptProvidedSettings(bridge, undefined)).toEqual({});
  });
});

describe('instance names', () => {
  it('accepts what Docker will take as a project name', () => {
    expect(isValidInstanceName('blink-front')).toBe(true);
    expect(isValidInstanceName('wyze1')).toBe(true);
  });

  it('refuses anything that could be read as something other than a name', () => {
    for (const bad of [
      '',
      '-leading',
      'Upper',
      'has space',
      'has/slash',
      'has.dot',
      '../escape',
      '$(whoami)',
      'a'.repeat(41),
    ]) {
      expect(isValidInstanceName(bad), bad).toBe(false);
    }
  });
});
