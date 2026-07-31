/**
 * Persistence. Uses the Node built-in SQLite driver so the service has zero
 * native build dependencies (important for the Alpine container and CI).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.ts';

export type Db = DatabaseSync;

export function openDatabase(url: string): Db {
  if (url !== ':memory:') {
    mkdirSync(dirname(url), { recursive: true });
  }
  const db = new DatabaseSync(url);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/** Idempotent, ordered, recorded. Safe to call on every boot. */
export function migrate(db: Db): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);

  const done = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );

  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const insert = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  for (const m of MIGRATIONS) {
    if (done.has(m.id)) {
      alreadyApplied.push(m.id);
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      insert.run(m.id, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.id} failed: ${(err as Error).message}`);
    }
  }

  return { applied, alreadyApplied };
}

/** Verifies every declared migration is recorded — used by CI. */
export function verifyMigrations(db: Db): { ok: boolean; missing: string[] } {
  const done = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  const missing = MIGRATIONS.filter((m) => !done.has(m.id)).map((m) => m.id);
  return { ok: missing.length === 0, missing };
}
