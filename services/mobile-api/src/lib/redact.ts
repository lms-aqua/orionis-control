/**
 * Secret redaction for logs, diagnostics and error details.
 *
 * Applied to every structured log line and to any `details` payload attached to
 * an error before it leaves the process. Redaction is by key name (recursively)
 * and by value pattern, so a token that lands in an unexpected field is still
 * caught.
 */

const SENSITIVE_KEY = new RegExp(
  [
    'pass(word|phrase)?',
    'secret',
    'token',
    'authorization',
    'auth',
    'cookie',
    'set-cookie',
    'api[-_]?key',
    'client[-_]?secret',
    'private[-_]?key',
    'refresh',
    'code[-_]?verifier',
    'session[-_]?key',
    'signing[-_]?key',
    'credential',
    'bearer',
    'otp',
    'totp',
  ].join('|'),
  'i',
);

/** Value-shaped secrets that must never survive, whatever key they sit under. */
const SENSITIVE_VALUE: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // long base64 blobs
];

export const REDACTED = '[redacted]';

export function redactString(input: string): string {
  let out = input;
  for (const re of SENSITIVE_VALUE) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Deep-redact an arbitrary value. Cycles are handled; depth is bounded so a
 * pathological object cannot stall the logger.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.slice(0, 200).map((v) => redact(v, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1, seen);
    }
    return out;
  }

  return String(value);
}

/**
 * Strip credentials and query strings from a URL before it is logged.
 * Keeps origin + path so failures remain diagnosable.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = u.search ? '?[redacted]' : '';
    u.hash = '';
    return u.toString();
  } catch {
    return redactString(raw);
  }
}
