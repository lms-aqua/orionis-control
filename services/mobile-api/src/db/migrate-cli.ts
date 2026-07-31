/** `npm run migrate` — applies pending migrations and reports the result. */
import { loadConfig } from '../config/env.ts';
import { migrate, openDatabase, verifyMigrations } from './index.ts';

const { config } = loadConfig();
const db = openDatabase(config.databaseUrl);
const result = migrate(db);
const verified = verifyMigrations(db);

console.log(
  JSON.stringify(
    {
      database: config.databaseUrl,
      applied: result.applied,
      alreadyApplied: result.alreadyApplied.length,
      verified: verified.ok,
      missing: verified.missing,
    },
    null,
    2,
  ),
);

db.close();
process.exit(verified.ok ? 0 : 1);
