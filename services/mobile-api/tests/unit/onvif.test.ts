import { describe, expect, it } from 'vitest';
import { OnvifProvider, wsseDigest } from '../../src/adapters/connections/providers/onvif.ts';
import type { ProviderContext } from '../../src/adapters/connections/provider.ts';

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connectionId: 'conn-1',
    slug: 'onvif',
    settings: { baseUrl: 'http://192.168.1.90', username: 'admin' },
    secrets: { password: 'secret' },
    fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    timeoutMs: 1000,
    ...overrides,
  };
}

/** Routes SOAP calls by the operation named in the request body. */
function soapRouter(handlers: Record<string, string>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    for (const [op, xml] of Object.entries(handlers)) {
      if (body.includes(op)) return new Response(xml, { status: 200 });
    }
    return new Response('<fault/>', { status: 500 });
  }) as unknown as typeof fetch;
}

const PROFILES =
  '<trt:GetProfilesResponse>' +
  '<trt:Profiles token="Profile_1"><tt:Name>main</tt:Name></trt:Profiles>' +
  '<trt:Profiles token="Profile_2"><tt:Name>sub</tt:Name></trt:Profiles>' +
  '</trt:GetProfilesResponse>';

const SERVICES =
  '<tds:GetServicesResponse>' +
  '<tds:Service><tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace>' +
  '<tds:XAddr>http://0.0.0.0/onvif/Media</tds:XAddr></tds:Service>' +
  '</tds:GetServicesResponse>';

describe('wsseDigest', () => {
  it('matches a fixed Base64(SHA1(nonce·created·password)) vector', () => {
    const digest = wsseDigest(
      Buffer.from('0123456789abcdef'),
      '2024-01-01T00:00:00.000Z',
      'secret',
    );
    expect(digest).toBe('qjo0REneIm86OoLckqA5CdBwP38=');
  });
});

describe('OnvifProvider', () => {
  it('probe reports the number of media profiles', async () => {
    const fetchImpl = soapRouter({ GetServices: SERVICES, GetProfiles: PROFILES });
    const result = await new OnvifProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/2 media profile/i);
  });

  it('reports a login error on an unauthorized SOAP fault', async () => {
    const fetchImpl = (async () =>
      new Response('<s:Fault><s:Subcode>ter:NotAuthorized</s:Subcode></s:Fault>', {
        status: 500,
      })) as unknown as typeof fetch;
    const result = await new OnvifProvider(ctx({ fetchImpl })).probe();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the ONVIF login/i);
  });

  it('gets the stream URI and injects credentials, rehosting to the reachable IP', async () => {
    const streamResp =
      '<trt:GetStreamUriResponse><trt:MediaUri>' +
      '<tt:Uri>rtsp://0.0.0.0:554/Streaming/Channels/101</tt:Uri>' +
      '</trt:MediaUri></trt:GetStreamUriResponse>';
    const fetchImpl = soapRouter({ GetStreamUri: streamResp });
    const provider = new OnvifProvider(
      ctx({
        fetchImpl,
        // A configured profile token skips profile discovery for this call.
        settings: { baseUrl: 'http://192.168.1.90', username: 'admin', profileToken: 'Profile_1' },
      }),
    );
    const session = await provider.createStreamSession({
      cameraId: 'camera',
      preferredProtocols: ['hls'],
      quality: 'auto',
      ttlSeconds: 60,
    });
    // Host rewritten from the camera's self-reported 0.0.0.0 to the address we
    // can reach, credentials added, path and port preserved.
    expect(session.playbackUrl).toBe('rtsp://admin:secret@192.168.1.90:554/Streaming/Channels/101');
  });

  it('fetches the snapshot URI the camera returns', async () => {
    const snapResp =
      '<trt:GetSnapshotUriResponse><trt:MediaUri>' +
      '<tt:Uri>http://0.0.0.0/onvif-http/snapshot</tt:Uri>' +
      '</trt:MediaUri></trt:GetSnapshotUriResponse>';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes('GetSnapshotUri')) return new Response(snapResp, { status: 200 });
      // The follow-up image fetch (Digest helper), rehosted to the real IP.
      if (url.includes('/onvif-http/snapshot')) {
        expect(url).toContain('192.168.1.90');
        return new Response(Buffer.from([0xff, 0xd8]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response('<fault/>', { status: 500 });
    }) as unknown as typeof fetch;
    const provider = new OnvifProvider(
      ctx({
        fetchImpl,
        settings: { baseUrl: 'http://192.168.1.90', username: 'admin', profileToken: 'Profile_1' },
      }),
    );
    const snap = await provider.getSnapshot('camera');
    expect(snap.contentType).toBe('image/jpeg');
  });
});
