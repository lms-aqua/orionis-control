/**
 * Composition root. Everything is constructed here and injected, so tests can
 * swap any adapter, the clock or fetch without touching route code.
 */
import type { Config } from './config/env.ts';
import { migrate, openDatabase, type Db } from './db/index.ts';
import { SessionService } from './auth/sessions.ts';
import { OidcClient } from './auth/oidc.ts';
import { AuditLog } from './audit/audit.ts';
import { HttpOrionisAdapter } from './adapters/orionis/http.ts';
import { Go2rtcOrionisAdapter } from './adapters/orionis/go2rtc.ts';
import { MediaMtxRecordings } from './adapters/orionis/mediamtx-recordings.ts';
import { CaddyManagerClient } from './adapters/infra/caddymanager.ts';
import { UnconfiguredOrionisAdapter } from './adapters/orionis/unconfigured.ts';
import type { OrionisAdapter } from './adapters/orionis/types.ts';
import { HttpAdGuardAdapter, UnconfiguredAdGuardAdapter } from './adapters/adguard/http.ts';
import type { AdGuardAdapter } from './adapters/adguard/types.ts';
import { PushService } from './notifications/push.ts';
import { SecretsCipher } from './lib/secrets.ts';
import { ProvisioningDirectory } from './lib/provisioning.ts';
import {
  AggregateOrionisAdapter,
  buildProviderRegistry,
  ConnectionStore,
} from './adapters/connections/index.ts';

export interface AppServices {
  config: Config;
  db: Db;
  sessions: SessionService;
  oidc: OidcClient;
  audit: AuditLog;
  orionis: OrionisAdapter;
  infra: CaddyManagerClient;
  adguard: AdGuardAdapter;
  /** Null when no encryption key is configured, which disables the feature. */
  connections: ConnectionStore | null;
  push: PushService;
  startedAt: Date;
}

export interface BuildServicesOptions {
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  orionis?: OrionisAdapter;
  adguard?: AdGuardAdapter;
  db?: Db;
}

export function buildServices(config: Config, opts: BuildServicesOptions = {}): AppServices {
  const db = opts.db ?? openDatabase(config.databaseUrl);
  migrate(db);

  const fetchImpl = opts.fetchImpl ?? fetch;

  const infra = new CaddyManagerClient(
    config.infra.baseUrl,
    config.infra.apiKey,
    config.infra.timeoutMs,
    fetchImpl,
  );

  const envOrionis: OrionisAdapter =
    opts.orionis ??
    (config.orionis.configured
      ? config.orionis.adapter === 'go2rtc'
        ? new Go2rtcOrionisAdapter(
            config.orionis.baseUrl,
            config.orionis.timeoutMs,
            fetchImpl,
            config.orionis.cameraLabels,
            config.orionis.recordingsBaseUrl
              ? new MediaMtxRecordings(
                  config.orionis.recordingsBaseUrl,
                  config.orionis.timeoutMs,
                  config.orionis.recordingsRetentionDays,
                  fetchImpl,
                  config.orionis.recordingsPath,
                  config.orionis.recordingsQuotaBytes,
                )
              : null,
            config.orionis.enableWebrtc,
            config.orionis.wyzeBridgeUrl,
            config.orionis.recordingExclude,
            // Keep recently-viewed cameras' snapshots warm so the grid is instant.
            true,
          )
        : new HttpOrionisAdapter(
            config.orionis.baseUrl,
            config.orionis.serviceToken,
            config.orionis.timeoutMs,
            fetchImpl,
          )
      : new UnconfiguredOrionisAdapter());

  // --- camera connections ---------------------------------------------------
  // Sources added at runtime. The aggregate adapter wraps the environment-built
  // one rather than replacing it: with no connection enabled it delegates
  // straight through, so an existing deployment is untouched until someone adds
  // their first connection, and no restart is needed when they do.
  const connections: ConnectionStore | null = config.connections.enabled
    ? new ConnectionStore(
        db,
        buildProviderRegistry(),
        new SecretsCipher(config.connections.secretKey, config.connections.previousSecretKeys),
        fetchImpl,
        config.orionis.timeoutMs,
        config.connections.probeTtlMs,
        new ProvisioningDirectory(config.connections.provisioningDir),
        config.connections.maxBridges,
      )
    : null;

  const orionis: OrionisAdapter =
    connections && !opts.orionis
      ? new AggregateOrionisAdapter(
          () => connections.active(),
          (connectionId, error) => {
            // A source that failed mid-fan-out is recorded so the Connections
            // screen can explain a partial camera wall instead of leaving the
            // gap unexplained.
            connections.recordHealth(connectionId, {
              status: 'degraded',
              message: error instanceof Error ? error.message : 'This source failed to respond.',
              cameraCount: null,
              latencyMs: null,
              checkedAt: new Date().toISOString(),
            });
          },
          (connectionId) => connections.healthCached(connectionId),
          envOrionis,
        )
      : envOrionis;

  const adguard: AdGuardAdapter =
    opts.adguard ??
    (config.adguard.configured
      ? new HttpAdGuardAdapter(
          config.adguard.baseUrl,
          config.adguard.username,
          config.adguard.password,
          config.adguard.timeoutMs,
          fetchImpl,
        )
      : new UnconfiguredAdGuardAdapter());

  return {
    config,
    db,
    sessions: new SessionService(db, config),
    oidc: new OidcClient(config.oidc, fetchImpl),
    audit: new AuditLog(db, config.sessionSigningKey),
    orionis,
    infra,
    adguard,
    connections,
    push: new PushService(db, config),
    startedAt: new Date(),
  };
}
