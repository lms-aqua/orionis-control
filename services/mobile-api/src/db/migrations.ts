/**
 * Schema migrations, applied in array order and recorded by id.
 *
 * Rules: never edit a shipped migration — append a new one. Ids are sortable.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_initial',
    sql: `
      -- Users are projections of Authelia identities; no credentials are stored.
      CREATE TABLE users (
        id             TEXT PRIMARY KEY,          -- OIDC subject
        username       TEXT NOT NULL,
        display_name   TEXT,
        email          TEXT,
        role           TEXT NOT NULL,             -- viewer | operator | administrator
        groups_json    TEXT NOT NULL DEFAULT '[]',
        first_seen_at  TEXT NOT NULL,
        last_seen_at   TEXT NOT NULL
      );

      -- One row per signed-in device. Refresh tokens are stored hashed only.
      CREATE TABLE sessions (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id           TEXT NOT NULL,
        device_name         TEXT,
        device_model        TEXT,
        os_version          TEXT,
        app_version         TEXT,
        refresh_token_hash  TEXT NOT NULL,
        refresh_family      TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        last_used_at        TEXT NOT NULL,
        expires_at          TEXT NOT NULL,
        revoked_at          TEXT,
        revoked_reason      TEXT
      );
      CREATE INDEX idx_sessions_user   ON sessions(user_id);
      CREATE INDEX idx_sessions_hash   ON sessions(refresh_token_hash);
      CREATE INDEX idx_sessions_family ON sessions(refresh_family);

      -- Short-lived OIDC authorization transactions (state/nonce/PKCE).
      CREATE TABLE auth_transactions (
        state              TEXT PRIMARY KEY,
        nonce              TEXT NOT NULL,
        gateway_verifier   TEXT NOT NULL,   -- gateway <-> Authelia PKCE
        app_challenge      TEXT NOT NULL,   -- app <-> gateway PKCE (S256)
        app_state          TEXT NOT NULL,
        app_redirect_uri   TEXT NOT NULL,
        device_id          TEXT,
        created_at         TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        consumed_at        TEXT
      );

      -- One-time codes handed to the app after a successful Authelia login.
      CREATE TABLE authorization_codes (
        code_hash     TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        app_challenge TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        consumed_at   TEXT
      );

      -- Append-only audit trail for security-relevant actions.
      CREATE TABLE audit_events (
        id           TEXT PRIMARY KEY,
        occurred_at  TEXT NOT NULL,
        actor_id     TEXT,
        actor_name   TEXT,
        actor_role   TEXT,
        device_id    TEXT,
        action       TEXT NOT NULL,
        target_type  TEXT,
        target_id    TEXT,
        outcome      TEXT NOT NULL,          -- success | failure | denied
        reason       TEXT,
        request_id   TEXT,
        ip_hash      TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_audit_time   ON audit_events(occurred_at DESC);
      CREATE INDEX idx_audit_actor  ON audit_events(actor_id);
      CREATE INDEX idx_audit_action ON audit_events(action);

      -- APNs device tokens, one per session.
      CREATE TABLE push_devices (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        device_id     TEXT NOT NULL,
        token_hash    TEXT NOT NULL,
        token_cipher  TEXT NOT NULL,
        environment   TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE(user_id, device_id)
      );

      CREATE TABLE notification_preferences (
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id   TEXT NOT NULL,
        prefs_json  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, device_id)
      );

      -- Replay protection for sensitive writes.
      CREATE TABLE idempotency_keys (
        key           TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        endpoint      TEXT NOT NULL,
        request_hash  TEXT NOT NULL,
        status_code   INTEGER,
        response_json TEXT,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        PRIMARY KEY (key, user_id, endpoint)
      );

      -- Records who paused AdGuard protection, why, and until when.
      CREATE TABLE protection_overrides (
        id           TEXT PRIMARY KEY,
        actor_id     TEXT NOT NULL,
        actor_name   TEXT NOT NULL,
        disabled_at  TEXT NOT NULL,
        resume_at    TEXT,
        reason       TEXT,
        restored_at  TEXT,
        restored_by  TEXT
      );
      CREATE INDEX idx_protection_active ON protection_overrides(restored_at);
    `,
  },
  {
    id: '0002_stream_sessions',
    sql: `
      CREATE TABLE stream_sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        camera_id    TEXT NOT NULL,
        protocol     TEXT NOT NULL,
        quality      TEXT,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        revoked_at   TEXT
      );
      CREATE INDEX idx_stream_user   ON stream_sessions(user_id);
      CREATE INDEX idx_stream_camera ON stream_sessions(camera_id);
    `,
  },
  {
    id: '0003_event_acknowledgements',
    sql: `
      -- Acknowledgement state is owned by the gateway so it survives even when
      -- the upstream has no concept of it. Reconciled by the Orionis adapter
      -- when the upstream does support acknowledgement.
      CREATE TABLE event_acknowledgements (
        event_id        TEXT PRIMARY KEY,
        camera_id       TEXT,
        acknowledged_by TEXT NOT NULL,
        actor_name      TEXT NOT NULL,
        acknowledged_at TEXT NOT NULL,
        note            TEXT,
        synced_upstream INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_ack_camera ON event_acknowledgements(camera_id);
    `,
  },
  {
    id: '0004_user_preferences',
    sql: `
      CREATE TABLE user_preferences (
        user_id     TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        key         TEXT NOT NULL,
        value_json  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, device_id, key)
      );
    `,
  },
  {
    id: '0005_account_preferences',
    sql: `
      -- Deliberately not keyed by device, unlike user_preferences above.
      -- Which cameras someone has starred, and the order they want them in, is a
      -- property of the person rather than the handset: it should follow them to
      -- a second device instead of being re-created there.
      CREATE TABLE account_preferences (
        user_id     TEXT NOT NULL,
        key         TEXT NOT NULL,
        value_json  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `,
  },
  {
    id: '0006_stream_upstream_id',
    sql: `
      -- Gateway stream IDs authorize clients; upstream IDs tear down the actual
      -- RTSP/HLS producer. They are intentionally distinct and both are needed.
      ALTER TABLE stream_sessions ADD COLUMN upstream_id TEXT;
    `,
  },
  {
    id: '0007_hot_path_indexes',
    sql: `
      -- Housekeeping runs frequently; expiry indexes prevent full-table scans.
      CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
      CREATE INDEX idx_auth_transactions_expiry ON auth_transactions(expires_at);
      CREATE INDEX idx_authorization_codes_expiry ON authorization_codes(expires_at);
      CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);
      CREATE INDEX idx_stream_expiry ON stream_sessions(expires_at);

      -- Active-stream replacement and filtered audit pages are hot paths.
      CREATE INDEX idx_stream_active_owner
        ON stream_sessions(user_id, session_id, camera_id, revoked_at, expires_at);
      CREATE INDEX idx_audit_action_time ON audit_events(action, occurred_at DESC);
      CREATE INDEX idx_audit_actor_time ON audit_events(actor_id, occurred_at DESC);
    `,
  },
  {
    id: '0008_connections',
    sql: `
      -- Camera sources, configurable at runtime instead of only through env.
      --
      -- 'provider' names a plugin in the provider registry; 'settings_json'
      -- holds that plugin's non-secret configuration and 'secrets_json' its
      -- credentials, each value encrypted individually (see lib/secrets.ts).
      -- Secrets are a separate column so the non-secret half can be read,
      -- logged and diffed without ever touching the cipher.
      CREATE TABLE connections (
        id             TEXT PRIMARY KEY,
        provider       TEXT NOT NULL,
        name           TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        settings_json  TEXT NOT NULL DEFAULT '{}',
        secrets_json   TEXT NOT NULL DEFAULT '{}',
        -- Ordering for the merged camera wall. Lower sorts first; ties break
        -- on name so the order is total and stable across restarts.
        sort_order     INTEGER NOT NULL DEFAULT 100,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        created_by     TEXT
      );

      -- A connection's slug prefixes every camera ID it contributes
      -- ("frigate-main:driveway"), so two sources may use the same upstream
      -- camera name without colliding. Uniqueness is therefore load-bearing,
      -- not cosmetic.
      CREATE UNIQUE INDEX idx_connections_name ON connections(name);

      -- Health is observed, never authored: it records the last probe rather
      -- than anything the operator typed, so it is kept out of the config row
      -- and is safe to wipe.
      CREATE TABLE connection_health (
        connection_id  TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        status         TEXT NOT NULL,
        message        TEXT,
        camera_count   INTEGER,
        latency_ms     INTEGER,
        checked_at     TEXT NOT NULL
      );
    `,
  },
];
