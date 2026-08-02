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
import { UnconfiguredOrionisAdapter } from './adapters/orionis/unconfigured.ts';
import type { OrionisAdapter } from './adapters/orionis/types.ts';
import { HttpAdGuardAdapter, UnconfiguredAdGuardAdapter } from './adapters/adguard/http.ts';
import type { AdGuardAdapter } from './adapters/adguard/types.ts';
import { PushService } from './notifications/push.ts';

export interface AppServices {
  config: Config;
  db: Db;
  sessions: SessionService;
  oidc: OidcClient;
  audit: AuditLog;
  orionis: OrionisAdapter;
  adguard: AdGuardAdapter;
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

  const orionis: OrionisAdapter =
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
                )
              : null,
            config.orionis.enableWebrtc,
          )
        : new HttpOrionisAdapter(
            config.orionis.baseUrl,
            config.orionis.serviceToken,
            config.orionis.timeoutMs,
            fetchImpl,
          )
      : new UnconfiguredOrionisAdapter());

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
    adguard,
    push: new PushService(db, config),
    startedAt: new Date(),
  };
}
