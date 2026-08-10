/**
 * A bridge that streams an interactively-authenticated source is only ever
 * handed a *verified* session.
 *
 * The bridge cannot log in for itself with a bare email and password without
 * being mailed a verification code at a console nobody is watching — on every
 * start. So the store refuses to stand one up until the in-app sign-in has
 * produced a token, and once a bridge exists a later sign-in reseeds it with the
 * refreshed session rather than leaving it on a stale one.
 *
 * Tested at the store rather than over HTTP because the interesting object is
 * the request file, and a fake provider gives control over when a sign-in
 * completes that Blink's own API does not.
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

/** Runs the two-step sign-in the fake provider models. */
async function signIn(store: ConnectionStore, id: string): Promise<void> {
  const challenge = await store.beginAuth(id, 'user-1');
  expect(challenge.status).toBe('challenge');
  const done = await store.completeAuth(id, 'challenge-1', '123456', 'user-1');
  expect(done.status).toBe('complete');
}

afterEach(async () => {
  if (shared) await rm(shared, { recursive: true, force: true });
  shared = null;
});

describe('a bridge for an interactive source is only handed a verified session', () => {
  it('refuses to set up the bridge until the sign-in is done', async () => {
    const { store, dir } = await buildStore();
    const record = store.create({
      provider: 'bridged',
      name: 'Bridged Source',
      settings: { email: 'pat@example.invalid' },
    });

    // Before sign-in the bridge would have only an email and a password, so the
    // request is refused rather than written — nothing to hand over, and starting
    // anyway is what mails a code to a console nobody is watching.
    await expect(store.requestProvisioning(record.id, 'user-1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(readRequest(dir, record.id)).rejects.toThrow();
    expect(store.provisioning(record.id)).toBeNull();

    await signIn(store, record.id);

    // Now the request carries the verified session: the token, and the account
    // identifiers the bridge needs to use it rather than start over.
    const prov = await store.requestProvisioning(record.id, 'user-1');
    expect(prov.state).toBe('pending');
    const handover = (await readRequest(dir, record.id)).handover as Record<string, string>;
    expect(handover.authToken).toBe('token-from-step-one');
    expect(handover.accountId).toBe('42');
    expect(handover.email).toBe('pat@example.invalid');
  });

  it('reseeds an existing bridge when a later sign-in refreshes the session', async () => {
    const { store, dir } = await buildStore();
    const record = store.create({
      provider: 'bridged',
      name: 'Bridged Source',
      settings: { email: 'pat@example.invalid' },
    });

    await signIn(store, record.id);
    const first = await store.requestProvisioning(record.id, 'user-1');

    // A later re-authentication (a refreshed token) must reach the running
    // bridge without the user asking for one again.
    await signIn(store, record.id);

    const after = store.provisioning(record.id);
    expect(after?.state).toBe('pending');
    // A fresh request id, so a status file answering the previous one cannot be
    // mistaken for an answer to this.
    expect(after?.requestId).not.toBe(first.requestId);
    const handover = (await readRequest(dir, record.id)).handover as Record<string, string>;
    expect(handover.authToken).toBe('token-from-step-one');
    expect(handover.accountId).toBe('42');
  });

  it('does nothing when no bridge was ever asked for', async () => {
    const { store, dir } = await buildStore();
    const record = store.create({
      provider: 'bridged',
      name: 'Unbridged',
      settings: { email: 'pat@example.invalid' },
    });

    await signIn(store, record.id);

    // A sign-in must not conjure a container nobody asked for.
    await expect(readRequest(dir, record.id)).rejects.toThrow();
    expect(store.provisioning(record.id)).toBeNull();
  });

  it('does not fail a refresh sign-in because the shared directory is gone', async () => {
    const { store } = await buildStore();
    const record = store.create({
      provider: 'bridged',
      name: 'Fragile',
      settings: { email: 'pat@example.invalid' },
    });
    await signIn(store, record.id);
    await store.requestProvisioning(record.id, 'user-1');

    // The directory disappears before a later refresh — a volume unmounted, a
    // disk full. The session is real and the user typed a real code; reporting
    // that as a failure would be a lie, and the token must still be stored so a
    // later retry can hand it over.
    if (shared) await rm(shared, { recursive: true, force: true });

    await signIn(store, record.id);
    expect(store.get(record.id).secretsSet.authToken).toBe(true);
  });
});
