import { describe, expect, it, vi } from 'vitest';
import { OidcClient } from '../../src/auth/oidc.ts';
import type { OidcConfig } from '../../src/config/env.ts';

const config: OidcConfig = {
  configured: true,
  issuerUrl: 'https://auth.invalid',
  clientId: 'client',
  clientSecret: 'secret',
  redirectUri: 'orionis://callback',
  scopes: 'openid',
  roleClaim: 'groups',
};

const document = {
  issuer: config.issuerUrl,
  authorization_endpoint: `${config.issuerUrl}/authorize`,
  token_endpoint: `${config.issuerUrl}/token`,
  jwks_uri: `${config.issuerUrl}/jwks`,
  code_challenge_methods_supported: ['S256'],
};

describe('OIDC discovery caching', () => {
  it('coalesces concurrent discovery requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return Response.json(document);
    });
    const client = new OidcClient(config, fetchImpl);
    const first = client.discover();
    const second = client.discover();
    expect(fetchImpl).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([document, document]);
  });

  it('serves the cached document after a forced refresh cannot reach the provider', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(document))
      .mockRejectedValueOnce(new TypeError('offline'));
    const client = new OidcClient(config, fetchImpl);
    const first = await client.discover();
    await expect(client.discover(true)).resolves.toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not answer a forced refresh from a load that started before it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return Response.json(document);
    });
    const client = new OidcClient(config, fetchImpl);
    // The health check forces a refresh while an ordinary load is in flight. It
    // needs its own request: joining the older one would report a result that
    // predates the probe as live reachability.
    const ordinary = client.discover();
    const forced = client.discover(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    release();
    await expect(Promise.all([ordinary, forced])).resolves.toEqual([document, document]);
  });

  it('coalesces concurrent forced refreshes with each other', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return Response.json(document);
    });
    const client = new OidcClient(config, fetchImpl);
    const first = client.discover(true);
    const second = client.discover(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([document, document]);
  });

  it('does not force a network request while the cached document is fresh', async () => {
    const fetchImpl = vi.fn(async () => Response.json(document));
    const client = new OidcClient(config, fetchImpl);
    await client.discover();
    await client.discover();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
