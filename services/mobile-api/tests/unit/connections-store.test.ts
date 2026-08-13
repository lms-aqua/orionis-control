/**
 * The connection store: configuration, credentials and lifecycle.
 *
 * The properties worth pinning are the ones that silently corrupt something
 * else when they break — a slug that moves, a credential that gets blanked by
 * an unrelated edit, sign-in state discarded halfway through a two-step login.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type Db } from '../../src/db/index.ts';
import { ConnectionStore } from '../../src/adapters/connections/store.ts';
import { ProviderRegistry } from '../../src/adapters/connections/provider.ts';
import { SecretsCipher } from '../../src/lib/secrets.ts';
import { AppError } from '../../src/lib/errors.ts';
import { FakeInteractiveProvider, FakeProvider, fakeDescriptor } from '../helpers/fake-provider.ts';

const KEY = 'k'.repeat(48);
const OLD_KEY = 'o'.repeat(48);

const noFetch: typeof fetch = async () => new Response('{}', { status: 200 });

function buildStore(
  cipher = new SecretsCipher(KEY),
  cleanupConnection?: (connectionId: string) => void,
): { store: ConnectionStore; db: Db } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);

  const registry = new ProviderRegistry();
  registry.register(
    fakeDescriptor({ id: 'fake' }),
    (ctx) => new FakeProvider(ctx, { cameras: ['a'] }),
    cleanupConnection,
  );
  registry.register(
    fakeDescriptor({ id: 'failing' }),
    (ctx) => new FakeProvider(ctx, { failing: true }),
  );
  registry.register(
    {
      ...fakeDescriptor({ id: 'interactive' }),
      capabilities: { ...fakeDescriptor().capabilities, interactiveAuth: true },
    },
    (ctx) => new FakeInteractiveProvider(ctx),
  );

  return { store: new ConnectionStore(db, registry, cipher, noFetch, 1000, 60_000), db };
}

describe('ConnectionStore', () => {
  let store: ConnectionStore;

  beforeEach(() => {
    store = buildStore().store;
  });

  describe('identity', () => {
    it('assigns a slug from the name', () => {
      const created = store.create({ provider: 'fake', name: 'Frigate Main' });
      expect(created.slug).toBe('frigate-main');
    });

    it('keeps the slug when the connection is renamed', () => {
      // The slug prefixes every camera ID this source has handed out, and the
      // app stores favourites by ID. A rename must not re-identify cameras.
      const created = store.create({ provider: 'fake', name: 'Frigate Main' });
      const renamed = store.update(created.id, { name: 'Garage NVR' });
      expect(renamed.name).toBe('Garage NVR');
      expect(renamed.slug).toBe('frigate-main');
    });

    it('refuses a second connection that would slugify onto the first', () => {
      store.create({ provider: 'fake', name: 'Front Door' });
      expect(() => store.create({ provider: 'fake', name: 'front  door!' })).toThrow(AppError);
    });

    it('refuses a name with nothing to slugify', () => {
      expect(() => store.create({ provider: 'fake', name: '!!!' })).toThrow(AppError);
    });

    it('refuses an unknown provider', () => {
      expect(() => store.create({ provider: 'nope', name: 'Whatever' })).toThrow(AppError);
    });
  });

  describe('credentials', () => {
    it('never returns a stored value, only which keys are set', () => {
      const created = store.create({
        provider: 'fake',
        name: 'Frigate',
        secrets: { apiKey: 'super-secret-value' },
      });
      expect(created.secretsSet).toEqual({ apiKey: true });
      expect(JSON.stringify(created)).not.toContain('super-secret-value');
    });

    it('keeps credentials that an unrelated edit did not mention', () => {
      // The API never hands the value back, so a client editing a URL cannot
      // round-trip it — merging is what stops that edit from blanking it.
      const created = store.create({
        provider: 'fake',
        name: 'Frigate',
        settings: { baseUrl: 'http://frigate:5000' },
        secrets: { apiKey: 'keep-me' },
      });
      const updated = store.update(created.id, { settings: { baseUrl: 'http://frigate:5001' } });
      expect(updated.secretsSet).toEqual({ apiKey: true });
      expect(store.instance(updated.id)).toBeTruthy();
    });

    it('clears a credential when an empty string is sent for it', () => {
      const created = store.create({
        provider: 'fake',
        name: 'Frigate',
        secrets: { apiKey: 'remove-me' },
      });
      const updated = store.update(created.id, { secrets: { apiKey: '' } });
      expect(updated.secretsSet).toEqual({});
    });

    it('hands the decrypted value to the provider and nowhere else', () => {
      const created = store.create({
        provider: 'fake',
        name: 'Frigate',
        secrets: { apiKey: 'plain-value' },
      });
      const provider = store.instance(created.id) as unknown as FakeProvider;
      expect(provider.ctx.secrets.apiKey).toBe('plain-value');
    });
  });

  describe('upstream addresses', () => {
    it('refuses a link-local address at the point it is typed', () => {
      expect(() =>
        store.create({
          provider: 'fake',
          name: 'Metadata',
          settings: { baseUrl: 'http://169.254.169.254/' },
        }),
      ).toThrow(AppError);
    });

    it('refuses a non-HTTP scheme', () => {
      expect(() =>
        store.create({
          provider: 'fake',
          name: 'Local file',
          settings: { baseUrl: 'file:///etc/hosts' },
        }),
      ).toThrow(AppError);
    });

    it('applies the same check on update, not only on create', () => {
      const created = store.create({ provider: 'fake', name: 'Frigate' });
      expect(() =>
        store.update(created.id, { settings: { baseUrl: 'http://metadata.google.internal/' } }),
      ).toThrow(AppError);
    });
  });

  describe('instances and health', () => {
    it('reuses one provider instance until the connection changes', () => {
      const created = store.create({ provider: 'fake', name: 'Frigate' });
      const first = store.instance(created.id);
      expect(store.instance(created.id)).toBe(first);

      // An edit must take effect immediately rather than at the next restart.
      store.update(created.id, { name: 'Frigate Two' });
      expect(store.instance(created.id)).not.toBe(first);
    });

    it('records a probe and serves it from cache until it goes stale', async () => {
      const created = store.create({ provider: 'fake', name: 'Frigate' });
      const first = await store.probe(created.id);
      expect(first.status).toBe('healthy');

      const cached = await store.healthCached(created.id);
      expect(cached.checkedAt).toBe(first.checkedAt);
    });

    it('records an unreachable source rather than throwing', async () => {
      const created = store.create({ provider: 'failing', name: 'Broken' });
      const health = await store.probe(created.id);
      expect(health.status).toBe('unreachable');
      expect(store.health(created.id)?.status).toBe('unreachable');
    });

    it('lists only enabled connections as active', () => {
      store.create({ provider: 'fake', name: 'On' });
      const off = store.create({ provider: 'fake', name: 'Off' });
      store.update(off.id, { enabled: false });
      expect(store.active().map((c) => c.name)).toEqual(['On']);
    });

    it('orders active connections by the operator-chosen position', () => {
      store.create({ provider: 'fake', name: 'Second', sortOrder: 20 });
      store.create({ provider: 'fake', name: 'First', sortOrder: 10 });
      expect(store.active().map((c) => c.name)).toEqual(['First', 'Second']);
    });

    it('drops a removed connection and its cached instance', () => {
      const cleaned: string[] = [];
      const cleanupStore = buildStore(new SecretsCipher(KEY), (id) => cleaned.push(id)).store;
      const created = cleanupStore.create({ provider: 'fake', name: 'Gone' });
      cleanupStore.remove(created.id);
      expect(() => cleanupStore.get(created.id)).toThrow(AppError);
      expect(cleaned).toEqual([created.id]);
    });
  });

  describe('interactive sign-in', () => {
    it('persists nothing while a challenge is outstanding', async () => {
      const created = store.create({ provider: 'interactive', name: 'Blink' });
      const begun = await store.beginAuth(created.id);
      expect(begun.status).toBe('challenge');
      // Half-authenticated state must not reach the row: an abandoned attempt
      // should leave the connection exactly as it was.
      expect(store.get(created.id).secretsSet).toEqual({});
    });

    it('survives an edit landing between the two steps', async () => {
      // The regression this exists for: sign-in state lived on the cached
      // provider instance, and any write invalidated that cache — so an edit
      // (or persisting the first step's token) silently made the code
      // unverifiable.
      const created = store.create({ provider: 'interactive', name: 'Blink' });
      await store.beginAuth(created.id);
      store.update(created.id, { name: 'Blink Home' });

      const completed = await store.completeAuth(created.id, 'challenge-1', '123456');
      expect(completed.status).toBe('complete');
    });

    it('stores what the completed sign-in produced, splitting secrets from facts', async () => {
      const created = store.create({ provider: 'interactive', name: 'Blink' });
      await store.beginAuth(created.id);
      await store.completeAuth(created.id, 'challenge-1', '123456');

      const record = store.get(created.id);
      expect(record.secretsSet.authToken).toBe(true);
      // An account id is an identifier, not a credential; it stays readable.
      expect(record.settings.accountId).toBe(42);
    });

    it('reports a wrong code as failed and stores nothing', async () => {
      const created = store.create({ provider: 'interactive', name: 'Blink' });
      await store.beginAuth(created.id);
      const result = await store.completeAuth(created.id, 'challenge-1', '000000');
      expect(result.status).toBe('failed');
      expect(store.get(created.id).secretsSet).toEqual({});
    });

    it('refuses interactive sign-in on a provider that has none', async () => {
      const created = store.create({ provider: 'fake', name: 'Frigate' });
      await expect(store.beginAuth(created.id)).rejects.toThrow(AppError);
    });
  });

  describe('key rotation', () => {
    it('rewraps values written under a retired key', () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON;');
      migrate(db);
      const registry = new ProviderRegistry();
      registry.register(fakeDescriptor({ id: 'fake' }), (ctx) => new FakeProvider(ctx));

      // Written under the old key...
      const before = new ConnectionStore(db, registry, new SecretsCipher(OLD_KEY), noFetch);
      const created = before.create({
        provider: 'fake',
        name: 'Frigate',
        secrets: { apiKey: 'v' },
      });

      // ...then the key is rotated, with the old one kept for decryption.
      const after = new ConnectionStore(db, registry, new SecretsCipher(KEY, [OLD_KEY]), noFetch);
      expect(after.rewrapSecrets()).toEqual({ rewrapped: 1, failed: [] });

      // Now readable with the new key alone.
      const rotated = new ConnectionStore(db, registry, new SecretsCipher(KEY), noFetch);
      const provider = rotated.instance(created.id) as unknown as FakeProvider;
      expect(provider.ctx.secrets.apiKey).toBe('v');
    });

    it('names connections it cannot read instead of pretending the rotation was clean', () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON;');
      migrate(db);
      const registry = new ProviderRegistry();
      registry.register(fakeDescriptor({ id: 'fake' }), (ctx) => new FakeProvider(ctx));

      const before = new ConnectionStore(db, registry, new SecretsCipher(OLD_KEY), noFetch);
      const created = before.create({
        provider: 'fake',
        name: 'Frigate',
        secrets: { apiKey: 'v' },
      });

      // The old key was not carried over — the honest outcome is "these need
      // re-entering", not silence.
      const orphaned = new ConnectionStore(db, registry, new SecretsCipher(KEY), noFetch);
      expect(orphaned.rewrapSecrets()).toEqual({ rewrapped: 0, failed: [created.id] });
    });

    it('keeps every other source alive when one connection cannot be decrypted', () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON;');
      migrate(db);
      const registry = new ProviderRegistry();
      registry.register(fakeDescriptor({ id: 'fake' }), (ctx) => new FakeProvider(ctx));

      const before = new ConnectionStore(db, registry, new SecretsCipher(OLD_KEY), noFetch);
      const orphan = before.create({ provider: 'fake', name: 'Orphan', secrets: { apiKey: 'v' } });

      const after = new ConnectionStore(db, registry, new SecretsCipher(KEY), noFetch);
      after.create({ provider: 'fake', name: 'Healthy' });

      expect(after.active().map((c) => c.name)).toEqual(['Healthy']);
      expect(after.health(orphan.id)?.status).toBe('unreachable');
    });
  });
});
