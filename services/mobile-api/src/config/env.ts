/**
 * Environment loading, typed validation and startup reporting.
 *
 * Design rule: a missing optional upstream must NOT prevent the gateway from
 * starting. It degrades that feature to a typed SERVICE_NOT_CONFIGURED error so
 * the app can render an honest state. Only values that would make the gateway
 * unsafe (session key, OIDC identity) are hard requirements outside tests.
 */
import { z } from 'zod';

const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export interface CameraLabel {
  name: string;
  location: string | null;
}

/**
 * Parses `ORIONIS_CAMERA_LABELS` into per-camera display names.
 *
 * Upstreams that key cameras by an opaque id (go2rtc names its streams after the
 * Scrypted device id) leave the app showing "Camera 57". This maps those ids to
 * something a person recognises, without inventing a name for an id that has no
 * entry.
 *
 * Format: `id=Name|Location` entries separated by commas; the location is
 * optional. Example: `57=Driveway|Outside,56=Shed`.
 */
export function parseCameraLabels(raw: string | undefined): Record<string, CameraLabel> {
  const labels: Record<string, CameraLabel> = {};
  for (const entry of csv(raw)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const id = entry.slice(0, eq).trim();
    const rest = entry.slice(eq + 1);
    const [namePart, locationPart] = rest.split('|');
    const name = (namePart ?? '').trim();
    if (!id || !name) continue;
    const location = (locationPart ?? '').trim();
    labels[id] = { name, location: location || null };
  }
  return labels;
}

const RawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  ALLOWED_APP_REDIRECT_SCHEMES: z.string().default('orioniscontrol'),

  SESSION_SIGNING_KEY: z.string().default(''),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).default(2_592_000),
  // A viewing session must outlive a normal look at a camera. At 120s the app
  // renewed at 90s, and renewal mints a new playback URL, which swaps the
  // player item and visibly restarts the video -- so watching a camera stuttered
  // every 90 seconds by construction. Revocation does not depend on this value:
  // every relay request re-checks the stream row (revoked_at, expires_at) and
  // that the signed-in session is still active, so a logout or an explicit
  // revoke takes effect immediately regardless of the token's remaining life.
  STREAM_TOKEN_TTL_SECONDS: z.coerce.number().int().min(15).max(7200).default(1800),

  AUTHELIA_ISSUER_URL: z.string().default(''),
  AUTHELIA_CLIENT_ID: z.string().default(''),
  AUTHELIA_CLIENT_SECRET: z.string().default(''),
  AUTHELIA_REDIRECT_URI: z.string().default(''),
  AUTHELIA_SCOPES: z.string().default('openid profile email groups'),
  AUTHELIA_ROLE_CLAIM: z.string().default('groups'),

  ROLE_VIEWER_GROUPS: z.string().default('orionis-viewers'),
  ROLE_OPERATOR_GROUPS: z.string().default('orionis-operators'),
  ROLE_ADMIN_GROUPS: z.string().default('orionis-admins'),

  ORIONIS_INTERNAL_URL: z.string().default(''),
  ORIONIS_SERVICE_TOKEN: z.string().default(''),
  // 'http' (default) speaks the Orionis Guard contract; 'go2rtc' speaks a
  // go2rtc server's API for camera list + snapshots.
  ORIONIS_ADAPTER: z.enum(['http', 'go2rtc']).default('http'),
  // Base URL of a MediaMTX HLS packager (e.g. http://orionis-hls:8888). When
  // set, the stream relay serves HLS from it instead of from go2rtc, whose own
  // HLS output stalls at two segments and drops the session after seconds.
  ORIONIS_HLS_BASE_URL: z.string().default(''),
  // Display names for upstreams that key cameras by an opaque id.
  // Format: `id=Name|Location` entries, comma separated. Location optional.
  ORIONIS_CAMERA_LABELS: z.string().default(''),
  ORIONIS_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8000),

  ADGUARD_INTERNAL_URL: z.string().default(''),
  ADGUARD_USERNAME: z.string().default(''),
  ADGUARD_PASSWORD: z.string().default(''),
  ADGUARD_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8000),

  DATABASE_URL: z.string().default('./data/orionis-control.db'),

  APNS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  APNS_TEAM_ID: z.string().default(''),
  APNS_KEY_ID: z.string().default(''),
  APNS_BUNDLE_ID: z.string().default('com.lostmediastudios.orioniscontrol'),
  APNS_PRIVATE_KEY: z.string().default(''),
  APNS_PRIVATE_KEY_PATH: z.string().default(''),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(240),
  RATE_LIMIT_SENSITIVE_MAX: z.coerce.number().int().min(1).default(10),
});

export type RawEnv = z.infer<typeof RawSchema>;

export interface RoleMapping {
  viewer: string[];
  operator: string[];
  administrator: string[];
}

export interface OidcConfig {
  configured: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  roleClaim: string;
}

export interface OrionisConfig {
  configured: boolean;
  adapter: 'http' | 'go2rtc';
  baseUrl: string;
  /** MediaMTX HLS base URL; empty means relay HLS from go2rtc itself. */
  hlsBaseUrl: string;
  /** Per-camera display names, keyed by upstream camera id. */
  cameraLabels: Record<string, CameraLabel>;
  serviceToken: string;
  timeoutMs: number;
}

export interface AdGuardConfig {
  configured: boolean;
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface ApnsConfig {
  configured: boolean;
  environment: 'sandbox' | 'production';
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: RawEnv['LOG_LEVEL'];
  publicBaseUrl: string;
  allowedRedirectSchemes: string[];
  sessionSigningKey: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  streamTokenTtlSeconds: number;
  oidc: OidcConfig;
  roles: RoleMapping;
  orionis: OrionisConfig;
  adguard: AdGuardConfig;
  apns: ApnsConfig;
  databaseUrl: string;
  rateLimit: { windowMs: number; max: number; sensitiveMax: number };
}

/** A single actionable startup finding. */
export interface ConfigFinding {
  level: 'error' | 'warn';
  key: string;
  message: string;
}

export interface LoadedConfig {
  config: Config;
  findings: ConfigFinding[];
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const parsed = RawSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  const e = parsed.data;
  const findings: ConfigFinding[] = [];
  const isProduction = e.NODE_ENV === 'production';
  const isTest = e.NODE_ENV === 'test';

  // --- session signing key -------------------------------------------------
  let signingKey = e.SESSION_SIGNING_KEY;
  if (!signingKey || signingKey.startsWith('REPLACE_ME')) {
    if (isProduction) {
      findings.push({
        level: 'error',
        key: 'SESSION_SIGNING_KEY',
        message:
          'Required in production. Generate 32+ random bytes: `openssl rand -base64 48`. Sessions cannot be signed without it.',
      });
    } else if (!isTest) {
      findings.push({
        level: 'warn',
        key: 'SESSION_SIGNING_KEY',
        message: 'Not set — an ephemeral development key is in use. All sessions drop on restart.',
      });
    }
    signingKey = signingKey || `dev-only-ephemeral-${Date.now()}-${Math.random()}`;
  } else if (Buffer.from(signingKey, 'utf8').length < 32) {
    findings.push({
      level: isProduction ? 'error' : 'warn',
      key: 'SESSION_SIGNING_KEY',
      message: 'Too short — supply at least 32 bytes of entropy.',
    });
  }

  // --- OIDC ----------------------------------------------------------------
  const oidcParts = {
    AUTHELIA_ISSUER_URL: e.AUTHELIA_ISSUER_URL,
    AUTHELIA_CLIENT_ID: e.AUTHELIA_CLIENT_ID,
    AUTHELIA_CLIENT_SECRET: e.AUTHELIA_CLIENT_SECRET,
    AUTHELIA_REDIRECT_URI: e.AUTHELIA_REDIRECT_URI,
  };
  const missingOidc = Object.entries(oidcParts)
    .filter(([, v]) => !v || v.startsWith('REPLACE_ME'))
    .map(([k]) => k);
  const oidcConfigured = missingOidc.length === 0;

  if (!oidcConfigured) {
    findings.push({
      level: isProduction ? 'error' : 'warn',
      key: missingOidc.join(', '),
      message: oidcConfigured
        ? ''
        : `Authelia OIDC is not fully configured; sign-in is disabled and /auth/login returns SERVICE_NOT_CONFIGURED. Missing: ${missingOidc.join(', ')}.`,
    });
  } else {
    if (isProduction && !isHttps(e.AUTHELIA_ISSUER_URL)) {
      findings.push({
        level: 'error',
        key: 'AUTHELIA_ISSUER_URL',
        message: 'Must be HTTPS in production.',
      });
    }
    if (isProduction && !isHttps(e.AUTHELIA_REDIRECT_URI)) {
      findings.push({
        level: 'error',
        key: 'AUTHELIA_REDIRECT_URI',
        message: 'Must be HTTPS in production and match the URI registered in Authelia exactly.',
      });
    }
  }

  // --- role mapping --------------------------------------------------------
  const roles: RoleMapping = {
    viewer: csv(e.ROLE_VIEWER_GROUPS),
    operator: csv(e.ROLE_OPERATOR_GROUPS),
    administrator: csv(e.ROLE_ADMIN_GROUPS),
  };
  if (roles.viewer.length + roles.operator.length + roles.administrator.length === 0) {
    findings.push({
      level: isProduction ? 'error' : 'warn',
      key: 'ROLE_*_GROUPS',
      message:
        'No group-to-role mapping configured. Every authenticated user would be denied. Set at least ROLE_VIEWER_GROUPS.',
    });
  }
  const overlap = roles.viewer
    .filter((g) => roles.administrator.includes(g))
    .concat(roles.operator.filter((g) => roles.administrator.includes(g)));
  if (overlap.length > 0) {
    findings.push({
      level: 'warn',
      key: 'ROLE_*_GROUPS',
      message: `Group(s) mapped to multiple roles: ${overlap.join(', ')}. The highest role wins.`,
    });
  }

  // --- public base URL -----------------------------------------------------
  if (isProduction && !isHttps(e.PUBLIC_BASE_URL)) {
    findings.push({
      level: 'error',
      key: 'PUBLIC_BASE_URL',
      message:
        'Must be HTTPS in production. The iOS app refuses non-HTTPS gateways in release builds.',
    });
  }

  // --- upstreams (optional, degrade gracefully) ----------------------------
  const orionisConfigured = Boolean(e.ORIONIS_INTERNAL_URL);
  if (!orionisConfigured) {
    findings.push({
      level: 'warn',
      key: 'ORIONIS_INTERNAL_URL',
      message:
        'Orionis Guard upstream not configured. Camera, event, recording and stream routes return SERVICE_NOT_CONFIGURED (no placeholder data is served).',
    });
  }

  const adguardConfigured = Boolean(
    e.ADGUARD_INTERNAL_URL && e.ADGUARD_USERNAME && e.ADGUARD_PASSWORD,
  );
  if (!adguardConfigured) {
    findings.push({
      level: 'warn',
      key: 'ADGUARD_INTERNAL_URL / ADGUARD_USERNAME / ADGUARD_PASSWORD',
      message:
        'AdGuard Home upstream not configured. AdGuard routes return SERVICE_NOT_CONFIGURED.',
    });
  }

  // --- APNs ----------------------------------------------------------------
  const apnsKey = e.APNS_PRIVATE_KEY.replace(/\\n/g, '\n');
  const apnsConfigured = Boolean(
    e.APNS_TEAM_ID && e.APNS_KEY_ID && (apnsKey || e.APNS_PRIVATE_KEY_PATH),
  );
  if (!apnsConfigured) {
    findings.push({
      level: 'warn',
      key: 'APNS_TEAM_ID / APNS_KEY_ID / APNS_PRIVATE_KEY',
      message:
        'APNs not configured. Device registration still succeeds and preferences persist, but delivery reports PUSH_NOT_CONFIGURED instead of silently dropping notifications.',
    });
  }

  const config: Config = {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    allowedRedirectSchemes: csv(e.ALLOWED_APP_REDIRECT_SCHEMES),
    sessionSigningKey: signingKey,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: e.REFRESH_TOKEN_TTL_SECONDS,
    streamTokenTtlSeconds: e.STREAM_TOKEN_TTL_SECONDS,
    oidc: {
      configured: oidcConfigured,
      issuerUrl: e.AUTHELIA_ISSUER_URL.replace(/\/+$/, ''),
      clientId: e.AUTHELIA_CLIENT_ID,
      clientSecret: e.AUTHELIA_CLIENT_SECRET,
      redirectUri: e.AUTHELIA_REDIRECT_URI,
      scopes: e.AUTHELIA_SCOPES,
      roleClaim: e.AUTHELIA_ROLE_CLAIM,
    },
    roles,
    orionis: {
      configured: orionisConfigured,
      adapter: e.ORIONIS_ADAPTER,
      baseUrl: e.ORIONIS_INTERNAL_URL.replace(/\/+$/, ''),
      hlsBaseUrl: e.ORIONIS_HLS_BASE_URL.replace(/\/+$/, ''),
      cameraLabels: parseCameraLabels(e.ORIONIS_CAMERA_LABELS),
      serviceToken: e.ORIONIS_SERVICE_TOKEN,
      timeoutMs: e.ORIONIS_TIMEOUT_MS,
    },
    adguard: {
      configured: adguardConfigured,
      baseUrl: e.ADGUARD_INTERNAL_URL.replace(/\/+$/, ''),
      username: e.ADGUARD_USERNAME,
      password: e.ADGUARD_PASSWORD,
      timeoutMs: e.ADGUARD_TIMEOUT_MS,
    },
    apns: {
      configured: apnsConfigured,
      environment: e.APNS_ENVIRONMENT,
      teamId: e.APNS_TEAM_ID,
      keyId: e.APNS_KEY_ID,
      bundleId: e.APNS_BUNDLE_ID,
      privateKey: apnsKey,
    },
    databaseUrl: e.DATABASE_URL,
    rateLimit: {
      windowMs: e.RATE_LIMIT_WINDOW_MS,
      max: e.RATE_LIMIT_MAX,
      sensitiveMax: e.RATE_LIMIT_SENSITIVE_MAX,
    },
  };

  return { config, findings: findings.filter((f) => f.message) };
}

/** Formats findings for the startup banner. Never prints values, only keys. */
export function formatFindings(findings: ConfigFinding[]): string[] {
  return findings.map((f) => `[config:${f.level}] ${f.key} — ${f.message}`);
}

export function hasBlockingFindings(findings: ConfigFinding[]): boolean {
  return findings.some((f) => f.level === 'error');
}
