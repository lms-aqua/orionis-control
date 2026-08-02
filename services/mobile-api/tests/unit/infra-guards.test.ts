import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.ts';
import {
  extractHosts,
  guardAutheliaConfig,
  guardCaddyConfig,
  summariseCaddyChange,
} from '../../src/lib/infra-guards.ts';

const GATEWAY = {
  gatewayHost: 'orionis-gateway.example.com',
  gatewayUpstream: 'orionis-mobile-api:8080',
};

const GOOD_CADDYFILE = `
mossertax.example.com {
  reverse_proxy mossertax-wp:80
}

orionis-gateway.example.com {
  reverse_proxy orionis-mobile-api:8080
}
`;

describe('guardCaddyConfig', () => {
  it('allows a config that keeps the gateway reachable', () => {
    expect(() => guardCaddyConfig({ ...GATEWAY, content: GOOD_CADDYFILE })).not.toThrow();
  });

  it('refuses a config that drops the gateway host entirely', () => {
    // This is the change that would disconnect the app from the server with no
    // way to undo it from the app.
    const content = GOOD_CADDYFILE.replace(
      /orionis-gateway\.example\.com/g,
      'something-else.example.com',
    );
    expect(() => guardCaddyConfig({ ...GATEWAY, content })).toThrow(AppError);
  });

  it('refuses a config that keeps the host but routes it elsewhere', () => {
    // A reachable name with nothing behind it fails just as completely.
    const content = GOOD_CADDYFILE.replace('orionis-mobile-api:8080', 'some-other-service:9000');
    expect(() => guardCaddyConfig({ ...GATEWAY, content })).toThrow(AppError);
  });

  it('refuses an empty config', () => {
    for (const content of ['', '   \n  ']) {
      expect(() => guardCaddyConfig({ ...GATEWAY, content })).toThrow(AppError);
    }
  });

  it('guards a JSON config the same as a Caddyfile', () => {
    // Caddy accepts either, and caddymanager passes either through, so a guard
    // that only understood one could be bypassed by sending the other.
    const json = JSON.stringify({
      apps: {
        http: {
          servers: {
            srv0: {
              routes: [
                {
                  match: [{ host: ['orionis-gateway.example.com'] }],
                  handle: [
                    { handler: 'reverse_proxy', upstreams: [{ dial: 'orionis-mobile-api:8080' }] },
                  ],
                },
              ],
            },
          },
        },
      },
    });
    expect(() => guardCaddyConfig({ ...GATEWAY, content: json })).not.toThrow();

    const withoutGateway = json.replace('orionis-gateway.example.com', 'elsewhere.example.com');
    expect(() => guardCaddyConfig({ ...GATEWAY, content: withoutGateway })).toThrow(AppError);
  });

  it('explains what is wrong rather than just refusing', () => {
    try {
      guardCaddyConfig({ ...GATEWAY, content: 'other.example.com { reverse_proxy x:1 }' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).message).toContain('orionis-gateway.example.com');
    }
  });
});

describe('extractHosts', () => {
  it('finds site hostnames', () => {
    const hosts = extractHosts(GOOD_CADDYFILE);
    expect(hosts).toContain('mossertax.example.com');
    expect(hosts).toContain('orionis-gateway.example.com');
  });

  it('ignores file names, bare IPs and upstreams without a domain', () => {
    const hosts = extractHosts(`
      import /etc/caddy/snippets.conf
      log { output file /var/log/caddy/access.log }
      reverse_proxy 10.0.0.5:8080
      reverse_proxy orionis-mobile-api:8080
    `);
    expect(hosts).not.toContain('snippets.conf');
    expect(hosts).not.toContain('access.log');
    expect(hosts.some((h) => /^\d+\./.test(h))).toBe(false);
  });
});

describe('summariseCaddyChange', () => {
  it('reports a removed site so it can be confirmed rather than surprising anyone', () => {
    const proposed = GOOD_CADDYFILE.replace(/mossertax\.example\.com \{[\s\S]*?\}\n/, '');
    const summary = summariseCaddyChange(GOOD_CADDYFILE, proposed);
    expect(summary.removedHosts).toContain('mossertax.example.com');
    expect(summary.removesLiveHosts).toBe(true);
  });

  it('reports an added site', () => {
    const proposed = `${GOOD_CADDYFILE}\nnewsite.example.com {\n  reverse_proxy new:80\n}\n`;
    const summary = summariseCaddyChange(GOOD_CADDYFILE, proposed);
    expect(summary.addedHosts).toContain('newsite.example.com');
    expect(summary.removesLiveHosts).toBe(false);
  });

  it('reports no change when nothing moved', () => {
    const summary = summariseCaddyChange(GOOD_CADDYFILE, GOOD_CADDYFILE);
    expect(summary.removedHosts).toEqual([]);
    expect(summary.addedHosts).toEqual([]);
  });
});

describe('guardAutheliaConfig', () => {
  const CLIENT = 'orionis-control-mobile';
  const GOOD = `
identity_providers:
  oidc:
    claims_policies:
      orionis:
        id_token: [groups, email, name]
    clients:
      - client_id: orionis-control-mobile
        claims_policy: orionis
`;

  it('allows a config that keeps the app able to sign in', () => {
    expect(() => guardAutheliaConfig({ content: GOOD, oidcClientId: CLIENT })).not.toThrow();
  });

  it('refuses a config missing the app OIDC client', () => {
    const content = GOOD.replace(/orionis-control-mobile/g, 'some-other-client');
    expect(() => guardAutheliaConfig({ content, oidcClientId: CLIENT })).toThrow(AppError);
  });

  it('refuses OIDC clients with no claims policy', () => {
    // Authelia 4.38+ leaves groups out of the id_token without one, and the
    // gateway reads the role from there -- every sign-in would be refused as
    // having no role.
    const content = GOOD.replace(/    claims_policies:[\s\S]*?\n(?=    clients:)/, '').replace(
      '        claims_policy: orionis\n',
      '',
    );
    expect(() => guardAutheliaConfig({ content, oidcClientId: CLIENT })).toThrow(AppError);
  });

  it('refuses an empty config', () => {
    expect(() => guardAutheliaConfig({ content: '  ', oidcClientId: CLIENT })).toThrow(AppError);
  });

  it('allows a config with no identity providers at all', () => {
    // Nothing to break: the claims-policy rule only applies where OIDC exists.
    const content = 'access_control:\n  default_policy: deny\norionis-control-mobile\n';
    expect(() => guardAutheliaConfig({ content, oidcClientId: CLIENT })).not.toThrow();
  });
});
