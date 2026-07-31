/**
 * Typed application errors.
 *
 * Every error surfaced to a client is one of these. Upstream exceptions are
 * normalised here so that stack traces, SQL, internal hostnames and upstream
 * credentials can never reach the wire.
 */

export type ErrorCode =
  // auth
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'SESSION_REVOKED'
  | 'REAUTHENTICATION_REQUIRED'
  | 'FORBIDDEN'
  | 'INSUFFICIENT_ROLE'
  | 'ACCOUNT_LOCKED'
  | 'OAUTH_STATE_INVALID'
  | 'OAUTH_EXCHANGE_FAILED'
  | 'PKCE_VERIFICATION_FAILED'
  | 'REDIRECT_URI_NOT_ALLOWED'
  | 'AUTHORIZATION_CODE_INVALID'
  // request
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RULE_DUPLICATE'
  | 'RULE_INVALID'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_API_VERSION'
  // upstream / capability
  | 'SERVICE_NOT_CONFIGURED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'CIRCUIT_OPEN'
  | 'CAPABILITY_UNSUPPORTED'
  | 'CAMERA_OFFLINE'
  | 'STREAM_UNAVAILABLE'
  | 'STREAM_TOKEN_EXPIRED'
  | 'PUSH_NOT_CONFIGURED'
  // generic
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  SESSION_REVOKED: 401,
  REAUTHENTICATION_REQUIRED: 401,
  FORBIDDEN: 403,
  INSUFFICIENT_ROLE: 403,
  ACCOUNT_LOCKED: 403,
  OAUTH_STATE_INVALID: 400,
  OAUTH_EXCHANGE_FAILED: 502,
  PKCE_VERIFICATION_FAILED: 400,
  REDIRECT_URI_NOT_ALLOWED: 400,
  AUTHORIZATION_CODE_INVALID: 400,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RULE_DUPLICATE: 409,
  RULE_INVALID: 422,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  UNSUPPORTED_API_VERSION: 400,
  SERVICE_NOT_CONFIGURED: 503,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  CIRCUIT_OPEN: 503,
  CAPABILITY_UNSUPPORTED: 501,
  CAMERA_OFFLINE: 503,
  STREAM_UNAVAILABLE: 503,
  STREAM_TOKEN_EXPIRED: 401,
  PUSH_NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
};

/** Whether retrying the identical request could plausibly succeed. */
const RECOVERABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'TOKEN_EXPIRED',
  'REAUTHENTICATION_REQUIRED',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
  'CIRCUIT_OPEN',
  'CAMERA_OFFLINE',
  'STREAM_UNAVAILABLE',
  'STREAM_TOKEN_EXPIRED',
  'INTERNAL_ERROR',
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly recoverable: boolean;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.recoverable = RECOVERABLE.has(code);
    this.details = details ?? null;
  }

  static notFound(what: string): AppError {
    return new AppError('NOT_FOUND', `${what} was not found.`);
  }

  static notConfigured(service: string): AppError {
    return new AppError(
      'SERVICE_NOT_CONFIGURED',
      `${service} is not configured on this gateway. An administrator must supply its connection settings.`,
    );
  }

  static unsupported(capability: string): AppError {
    return new AppError(
      'CAPABILITY_UNSUPPORTED',
      `${capability} is not supported by the connected hardware or upstream service.`,
    );
  }
}

export function statusForCode(code: ErrorCode): number {
  return STATUS[code];
}

export function isRecoverable(code: ErrorCode): boolean {
  return RECOVERABLE.has(code);
}
