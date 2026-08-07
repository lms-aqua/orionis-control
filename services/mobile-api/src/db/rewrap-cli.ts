/**
 * Re-encrypts stored connection credentials under the current primary key.
 *
 * The rotation procedure this exists for:
 *
 *   1. Put the new key in `CONNECTIONS_SECRET_KEY` and the old one in
 *      `CONNECTIONS_SECRET_KEY_PREVIOUS`.
 *   2. Restart the gateway. Everything keeps working — the old key still
 *      decrypts, the new one encrypts anything written from now on.
 *   3. Run this. Every credential is rewritten under the new key.
 *   4. Remove `CONNECTIONS_SECRET_KEY_PREVIOUS`.
 *
 * Without step 3 the old key is load-bearing forever, which is the opposite of
 * a rotation. Safe to run repeatedly: values already under the primary key are
 * left alone.
 */
import { loadConfig } from '../config/env.ts';
import { migrate, openDatabase } from './index.ts';
import { SecretsCipher } from '../lib/secrets.ts';
import { buildProviderRegistry, ConnectionStore } from '../adapters/connections/index.ts';

const { config } = loadConfig();

if (!config.connections.enabled) {
  console.error(
    'CONNECTIONS_SECRET_KEY is not set (or is under 32 characters). Nothing to rewrap.',
  );
  process.exit(1);
}

const db = openDatabase(config.databaseUrl);
migrate(db);

const store = new ConnectionStore(
  db,
  buildProviderRegistry(),
  new SecretsCipher(config.connections.secretKey, config.connections.previousSecretKeys),
  fetch,
);

const { rewrapped, failed } = store.rewrapSecrets();

console.log(`Rewrapped ${rewrapped} connection(s) under the current key.`);
if (failed.length > 0) {
  // Naming them is the useful outcome: these need their credentials re-entered,
  // and pretending the rotation was clean would hide that.
  console.error(
    `Could not decrypt ${failed.length} connection(s) with any configured key: ${failed.join(', ')}.`,
  );
  console.error(
    'Re-enter their credentials in the app, or restore the key they were written with.',
  );
  process.exit(2);
}
