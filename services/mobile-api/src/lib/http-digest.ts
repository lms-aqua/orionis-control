/**
 * HTTP Digest authentication (RFC 2617 / RFC 7616), for the camera CGI APIs
 * that default to it — Hikvision ISAPI and Dahua/Amcrest.
 *
 * Node's `fetch` does not implement Digest, so this does the two-step dance by
 * hand: an unauthenticated request draws the `WWW-Authenticate` challenge, the
 * response is computed from it, and the request is retried once with the
 * `Authorization` header. A camera that answers a bare request, or that
 * challenges with Basic instead, is handled without a second round-trip.
 *
 * The computation is split out as a pure function so it can be pinned against
 * the RFC's worked example without a live camera in the loop.
 */
import { createHash, randomBytes } from 'node:crypto';

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop: string | null;
  opaque: string | null;
  algorithm: string | null;
}

/**
 * Parses a `WWW-Authenticate: Digest …` header into its fields.
 *
 * Returns null for anything that is not a Digest challenge (including Basic),
 * so the caller can fall back rather than guess.
 */
export function parseDigestChallenge(header: string | null): DigestChallenge | null {
  if (!header) return null;
  const match = /^\s*Digest\s+(.*)$/is.exec(header);
  if (!match) return null;
  const fields: Record<string, string> = {};
  // Handles both quoted values (realm="x") and bare tokens (qop=auth).
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1]!)) !== null) {
    fields[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  if (!fields.realm || !fields.nonce) return null;
  return {
    realm: fields.realm,
    nonce: fields.nonce,
    qop: fields.qop ?? null,
    opaque: fields.opaque ?? null,
    algorithm: fields.algorithm ?? null,
  };
}

export interface DigestHeaderInput {
  username: string;
  password: string;
  method: string;
  /** Request-URI: path plus query, exactly as sent. */
  uri: string;
  challenge: DigestChallenge;
  /** Client nonce. Injected so the computation is testable; random otherwise. */
  cnonce?: string;
  /** Nonce count, hex, 8 digits. Defaults to the first use. */
  nc?: string;
}

/**
 * Builds the `Authorization: Digest …` header value for a single request.
 *
 * Pure and deterministic given `cnonce`/`nc`, which is what lets the RFC 2617
 * §3.5 worked example serve as a regression test.
 */
export function buildDigestHeader(input: DigestHeaderInput): string {
  const { username, password, method, uri, challenge } = input;
  const cnonce = input.cnonce ?? randomBytes(8).toString('hex');
  const nc = input.nc ?? '00000001';
  const algorithm = challenge.algorithm ?? 'MD5';

  let ha1 = md5(`${username}:${challenge.realm}:${password}`);
  if (/-sess$/i.test(algorithm)) {
    ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  }
  const ha2 = md5(`${method}:${uri}`);

  // A challenge may offer several qop values; `auth` is the only one these
  // cameras use, and the one HA2 above is computed for.
  const qop = challenge.qop
    ?.split(',')
    .map((q) => q.trim())
    .find((q) => q === 'auth' || q === '');
  const useQop = challenge.qop !== null && qop === 'auth';

  const response = useQop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (useQop) {
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (challenge.opaque !== null) {
    parts.push(`opaque="${challenge.opaque}"`);
  }
  return `Digest ${parts.join(', ')}`;
}

export interface DigestFetchOptions {
  username: string;
  password: string;
  method?: string;
  timeoutMs: number;
  headers?: Record<string, string>;
}

/**
 * Fetches `url` with Digest auth, falling back to Basic when the camera asks
 * for it and to no auth when it asks for none. Returns the final `Response`;
 * the caller reads the body.
 *
 * At most two requests are made: the unauthenticated probe that surfaces the
 * challenge, then the authenticated retry.
 */
export async function fetchWithDigest(
  fetchImpl: typeof fetch,
  url: string,
  opts: DigestFetchOptions,
): Promise<Response> {
  const method = opts.method ?? 'GET';
  const first = await fetchImpl(url, {
    method,
    headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (first.status !== 401) return first;

  // The challenge is spent whether or not we use it; drain the body so the
  // socket can be reused for the retry.
  await first.body?.cancel().catch(() => undefined);

  const wwwAuth = first.headers.get('www-authenticate');
  const challenge = parseDigestChallenge(wwwAuth);

  const parsed = new URL(url);
  const requestUri = `${parsed.pathname}${parsed.search}`;

  let authorization: string;
  if (challenge) {
    authorization = buildDigestHeader({
      username: opts.username,
      password: opts.password,
      method,
      uri: requestUri,
      challenge,
    });
  } else if (wwwAuth && /^\s*Basic/i.test(wwwAuth)) {
    const token = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
    authorization = `Basic ${token}`;
  } else {
    // Unauthorised with no scheme we understand; hand the 401 back so the
    // caller reports it rather than looping.
    return first;
  }

  return fetchImpl(url, {
    method,
    headers: { ...opts.headers, authorization },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
}
