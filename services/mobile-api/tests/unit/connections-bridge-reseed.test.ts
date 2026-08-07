/**
 * Handing a completed sign-in to the bridge that needs one.
 *
 * A bridge is asked for at creation, when the account has been typed but not
 * yet verified — so the first request cannot carry a session that does not exist
 * yet. Without the reseed, lostblink would start with an email and a password,
 * introduce itself to Blink as a stranger, and be mailed a verification code at
 * a console nobody is watching: exactly the failure the in-app code step was
 * built to replace.
 *
 * Tested at the store rather than over HTTP because the interesting object is
 * the *second* request file, and a fake provider gives control over when a
 * sign-in completes that Blink's own API does not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../src/db/index.ts';
import { ConnectionStore } from '../../src/adapters/connections/store.ts';
import { ProviderRegistry } from '../../src/adapters/connections/provider.ts';
import { ProvisioningDirectory } from '../../src/lib/provisioning.ts';
import { SecretsCipher } from '../../src/lib/secrets.ts';
import { FakeInteractiveProvider, fakeDescriptor } from '../helpers/fake-provider.ts';

const KEY = 'k'.repeat(48);
const noFetch: typeof fetch = async () => new Response('{}', { status: 200 });

let shared: string | null = null;

async function buildStore(): Promise<{ store: ConnectionStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orionis-reseed-'));
  shared = dir;

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);

  const registry = new ProviderRegistry();
  const base = fakeDescriptor({ id: 'bridged' });
  registry.register(
    {
      ...base,
      capabilities: { ...base.capabilities, interactiveAuth: true },
      fields: [
        ...base.fields,
        { key: 'email', label: 'Email', type: 'text', required: false },
        { key: 'accountId', label: 'Account', type: 'number', required: false },
        { key: 'authToken', label: 'Session token', type: 'secret', required: false },
      ],
      bridge: {
        template: 'bridged',
        summary: 'A bridge that exists only in tests.',
        provides: ['baseUrl'],
        handsOver: { settings: ['email', 'accountId'], secrets: ['authToken'] },
      },
    },
    (ctx) => new FakeInteractiveProvider(ctx),
  );

  return {
    store: new ConnectionStore(
      db,
      registry,
      new SecretsCipher(KEY),
      noFetch,
      1000,
      60_000,
      new ProvisioningDirectory(dir),
    ),
    dir,
  };
}

async function readRequest(dir: string, connectionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(dir, 'requests', `${connectionId}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

afterEach(async () => {
  if (shared) await rm(shared, { recursive: true, force: true });
  shared = null;
});

describe('reseeding a bridge after sign-in', () => {
  it('sends the session the moment verification succeeds', async () => {
    const { store, dir } = await buildStore();
    const record = store.create({
      provider: 'bridged',
      name: 'Bridged Source',
      settings: { email: 'pat@example.invalid' },
    });

    const first = await store.requestProvisioning(record.id, 'user-1');
    // Nothing to hand over yet — the account has been typed, not verified.
    const before = (await readRequest(dir, record.id)).handover as Record<string, string>;
    expect(before.email).toBe('pat@example.invalid');
    expect(before.authToken).toBeUndefined();

    const challenge = await store.beginAuth(record.id, 'user-1');
    expect(challenge.status).toBe('challenge');
    const done = await store.completeAuth(record.id, 'challenge-1', '123456', 'user-1');
    expect(done.status).toBe('complete');

    const after = (await readRequest(dir, record.id)).handover as Record<string, string>;
    expect(after.authToken).toBe('token-from-step-one');
    // And the identifiers the sign-in produced, which the instance needs to use
    // that token rather than start over.
    expect(after.accountId).toBe('42');

    // A fresh request id, so a status file answering the *previous* one cannot
    // be mistaken for an answer to this.
    const record2 = store.provisioning(record.id);
    expect(record2?.requestId).not.toBe(first.requestId);
    expect(record2?.state).toBe('pending');
  });

  it('does nothing when no bridge was ever asked for', async () => {
    const { store, dir } = await buildStore();
    const record = store.create({
      provider: 'bridged',
      name: 'Unbridged',
      settings: { email: 'pat@example.invalid' },
    });

    await store.beginAuth(record.id, 'user-1');
    await store.completeAuth(record.id, 'challenge-1', '123456', 'user-1');

    // A sign-in must not conjure a container nobody asked for.
    await expect(readRequest(dir, record.id)).rejects.toThrow();
    expect(store.provisioning(record.id)).toBeNull();
  });

  it('does not fail a good sign-in because the shared directory is not', async () => {
    const { store } = await buildStore();
    const record = store.create({
      provider: 'bridged',
      name: 'Fragile',
      settings: { email: 'pat@example.invalid' },
    });
    await store.requestProvisioning(record.id, 'user-1');

    // The directory disappears between the request and the verification — a
    // volume unmounted, a disk full. The Blink session is real and the user
    // typed a real code; reporting that as a failure would be a lie.
    if (shared) await rm(shared, { recursive: true, force: true });

    await store.beginAuth(record.id, 'user-1');
    const done = await store.completeAuth(record.id, 'challenge-1', '123456', 'user-1');
    expect(done.status).toBe('complete');
    // And the token is stored regardless, so a later retry can hand it over.
    expect(store.get(record.id).secretsSet.authToken).toBe(true);
  });

  it('hands a re-requested bridge the key it is already using', async () => {
    // A minted credential is the instance's identity. Rolling it on every
    // request would mean the running container and the connection disagreed
    // about the key, which fails as "unauthorised" rather than as anything
    // legible.
    const { store, dir } = await buildStore();
    const record = store.create({ provider: 'bridged', name: 'Stable Key', settings: {} });
    await store.requestProvisioning(record.id, 'user-1');
    const before = (await readRequest(dir, record.id)).handover as Record<string, string>;

    await store.beginAuth(record.id, 'user-1');
    await store.completeAuth(record.id, 'challenge-1', '123456', 'user-1');
    const after = (await readRequest(dir, record.id)).handover as Record<string, string>;

    expect(after.email).toBe(before.email);
    expect(after.authToken).toBe('token-from-step-one');
  });
});
