/**
 * Validation for upstream addresses that an operator types in.
 *
 * Connection settings are the first place in this gateway where a *stored*
 * value decides what the server will fetch. Everything else it talks to comes
 * from the environment, set by whoever deployed it. That difference matters:
 * a request-forgery bug here would let anyone who can reach the connections API
 * aim the gateway at addresses only it can see — cloud metadata, sibling
 * containers, an admin port on the host — and read the outcome back through
 * probe messages.
 *
 * Administrator-only is the primary control. This is the second one, because a
 * single mistake in a route guard should not be all that stands between a
 * typed URL and the metadata service.
 *
 * What is deliberately *not* blocked: private and loopback ranges. Reaching
 * `http://frigate:5000` or `http://127.0.0.1:1984` is the entire purpose of the
 * feature, so blanket-denying RFC1918 would break every real deployment. DNS
 * rebinding is likewise out of scope — the hostname is resolved by the fetch,
 * not here — and is accepted because the configuring party is already an
 * administrator.
 */
import { AppError } from './errors.ts';

const MAX_URL_LENGTH = 2048;

/** Link-local, which is how cloud metadata services are reached. */
const BLOCKED_V4_PREFIXES = ['169.254.'];

/** Hostnames that resolve to a metadata service on the major clouds. */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

export interface UpstreamUrlOptions {
  /** Defaults to HTTP(S). Stream fields also accept `rtsp:`/`rtsps:`. */
  protocols?: string[];
  /** Whether an empty value is acceptable (an optional field). */
  allowEmpty?: boolean;
}

/**
 * Returns the URL unchanged when it is safe to fetch, and throws a typed
 * validation error naming the field when it is not.
 *
 * `label` is the operator-facing field name, so the message can say which box
 * to fix rather than "invalid URL".
 */
export function assertSafeUpstreamUrl(
  raw: string,
  label: string,
  options: UpstreamUrlOptions = {},
): string {
  const protocols = options.protocols ?? ['http:', 'https:'];
  const value = (raw ?? '').trim();

  if (!value) {
    if (options.allowEmpty) return '';
    throw new AppError('VALIDATION_FAILED', `${label} is required.`);
  }
  if (value.length > MAX_URL_LENGTH) {
    throw new AppError('VALIDATION_FAILED', `${label} is too long to be a URL.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(
      'VALIDATION_FAILED',
      `${label} is not a valid URL. Include the scheme, for example ${protocols[0]}//host:port.`,
    );
  }

  if (!protocols.includes(url.protocol)) {
    const readable = protocols.map((p) => p.replace(':', '')).join(' or ');
    throw new AppError('VALIDATION_FAILED', `${label} must be a ${readable} URL.`);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new AppError('VALIDATION_FAILED', `${label} has no host.`);
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${label} points at a cloud metadata service, which this gateway will not request.`,
    );
  }
  if (BLOCKED_V4_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${label} points at a link-local address (169.254.x.x), which this gateway will not request.`,
    );
  }
  // IPv6 link-local (fe80::/10) and the v4-mapped form of the same.
  if (hostname.startsWith('fe80:') || hostname.includes('::ffff:169.254.')) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${label} points at a link-local address, which this gateway will not request.`,
    );
  }

  return value;
}

/**
 * Validates every URL-ish field of a provider's settings in one pass.
 *
 * Providers declare their fields, so which keys are URLs is already known and
 * does not have to be repeated per provider.
 */
export function assertSafeSettings(
  fields: { key: string; label: string; type: string; required: boolean }[],
  settings: Record<string, unknown>,
): void {
  for (const field of fields) {
    if (field.type !== 'url') continue;
    const raw = settings[field.key];
    if (raw === undefined || raw === null || raw === '') {
      if (field.required) {
        throw new AppError('VALIDATION_FAILED', `${field.label} is required.`);
      }
      continue;
    }
    assertSafeUpstreamUrl(String(raw), field.label, {
      // Stream endpoints are addressed with RTSP; API endpoints are not.
      protocols: /rtsp/i.test(field.key)
        ? ['rtsp:', 'rtsps:', 'http:', 'https:']
        : ['http:', 'https:'],
    });
  }
}
