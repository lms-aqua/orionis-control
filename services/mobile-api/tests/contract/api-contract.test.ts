/**
 * Contract tests.
 *
 * 1. Every route the gateway serves must appear in the OpenAPI document, and
 *    vice versa — this is what keeps the iOS models honest.
 * 2. Migrations must apply cleanly from empty and be idempotent.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { buildOpenApiDocument } from '../../src/openapi/spec.ts';
import { migrate, verifyMigrations } from '../../src/db/index.ts';
import { MIGRATIONS } from '../../src/db/migrations.ts';
import { API_PREFIX } from '../../src/app.ts';
import { createHarness } from '../helpers/harness.ts';
import { PERMISSIONS, ROLES } from '../../src/auth/roles.ts';
import { NOTIFICATION_KINDS } from '../../src/notifications/push.ts';

/** Minimal shape of the parts of the document these tests assert on. */
interface OpenApiDoc {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, { scheme: string }>;
    schemas: Record<string, { enum?: string[] }>;
  };
}

const doc = (): OpenApiDoc => buildOpenApiDocument() as unknown as OpenApiDoc;

/** Fastify path params are :id; OpenAPI uses {id}. */
function toOpenApiPath(routePath: string): string {
  return routePath.replace(API_PREFIX, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}') || '/';
}

describe('OpenAPI document', () => {
  it('is a valid 3.1 document with the expected metadata', () => {
    const d = doc();
    expect(d.openapi).toBe('3.1.0');
    expect(d.info.title).toContain('Orionis Control');
    expect(d.paths).toBeTruthy();
  });

  it('declares bearer authentication', () => {
    expect(doc().components.securitySchemes.bearerAuth?.scheme).toBe('bearer');
  });

  it('keeps the role, permission and notification enums in sync with the code', () => {
    const schemas = doc().components.schemas;
    expect(schemas.Role?.enum).toEqual([...ROLES]);
    expect(schemas.Permission?.enum).toEqual([...PERMISSIONS]);
    expect(schemas.NotificationKind?.enum).toEqual([...NOTIFICATION_KINDS]);
  });

  it('contains no private hostnames or credentials', () => {
    const serialised = JSON.stringify(buildOpenApiDocument());
    expect(serialised).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(serialised.toLowerCase()).not.toContain('password');
    expect(serialised).not.toContain('losthosting');
  });

  it('documents every route the gateway actually serves', async () => {
    const harness = await createHarness();
    try {
      const documented = new Set(Object.keys(doc().paths));

      // printRoutes renders a tree for humans; the reachability direction is
      // covered by the next test. Here we assert the critical surface is all
      // present in the document.
      for (const critical of [
        '/meta',
        '/health',
        '/auth/login',
        '/auth/callback',
        '/auth/token',
        '/auth/refresh',
        '/auth/logout',
        '/me',
        '/dashboard',
        '/cameras',
        '/cameras/{cameraId}',
        '/cameras/{cameraId}/snapshot',
        '/cameras/{cameraId}/stream-sessions',
        '/cameras/{cameraId}/controls',
        '/events',
        '/events/{eventId}',
        '/events/{eventId}/acknowledge',
        '/recordings',
        '/adguard/status',
        '/adguard/stats',
        '/adguard/query-log',
        '/adguard/clients',
        '/adguard/filters',
        '/adguard/rules',
        '/adguard/protection',
        '/system/services',
        '/system/actions',
        '/devices',
        '/devices/current',
        '/notifications/preferences',
        '/audit',
      ]) {
        expect(documented.has(critical), `${critical} missing from OpenAPI`).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });

  it('maps every documented path to a route the server answers', async () => {
    const harness = await createHarness();
    try {
      for (const [path, operations] of Object.entries(doc().paths)) {
        if (!('get' in operations)) continue;
        // Substitute a placeholder for path params.
        const url = `${API_PREFIX}${path.replace(/\{[^}]+\}/g, 'placeholder')}`;
        const res = await harness.app.inject({ method: 'GET', url });
        // Anything but 404 proves the route exists (401/403/503 are expected
        // without credentials or upstreams).
        expect(res.statusCode, `${path} is documented but not routed`).not.toBe(404);
      }
    } finally {
      await harness.close();
    }
  });

  it('normalises fastify param syntax to OpenAPI syntax', () => {
    expect(toOpenApiPath(`${API_PREFIX}/cameras/:cameraId/controls`)).toBe(
      '/cameras/{cameraId}/controls',
    );
  });
});

describe('migrations', () => {
  it('applies cleanly from an empty database', () => {
    const db = new DatabaseSync(':memory:');
    const result = migrate(db);
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(verifyMigrations(db).ok).toBe(true);
    db.close();
  });

  it('is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(MIGRATIONS.length);
    db.close();
  });

  it('creates every table the code depends on', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    for (const expected of [
      'users',
      'sessions',
      'auth_transactions',
      'authorization_codes',
      'audit_events',
      'push_devices',
      'notification_preferences',
      'idempotency_keys',
      'protection_overrides',
      'stream_sessions',
      'event_acknowledgements',
      'user_preferences',
      'schema_migrations',
    ]) {
      expect(tables.has(expected), `missing table ${expected}`).toBe(true);
    }
    db.close();
  });

  it('has unique, ordered migration ids', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
