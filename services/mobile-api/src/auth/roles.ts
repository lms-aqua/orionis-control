/**
 * Group-to-role mapping and the permission matrix.
 *
 * This is the authoritative authorisation model. The iOS app mirrors it purely
 * to decide what to draw — every protected route re-checks here, server-side.
 */
import type { RoleMapping } from '../config/env.ts';

export const ROLES = ['viewer', 'operator', 'administrator'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 1, operator: 2, administrator: 3 };

export const PERMISSIONS = [
  'cameras.view',
  'cameras.stream',
  'cameras.snapshot',
  'cameras.control.ptz',
  'cameras.control.light',
  'cameras.control.siren',
  'cameras.control.privacy',
  'cameras.control.recording',
  'cameras.control.detection',
  'cameras.restart',
  'events.view',
  'events.acknowledge',
  'recordings.view',
  'recordings.delete',
  'adguard.view',
  'adguard.protection.pause',
  'adguard.rules.write',
  'adguard.clients.write',
  'adguard.filters.write',
  'system.view',
  'system.actions.run',
  'audit.view',
  'infra.view',
  'infra.manage',
  'devices.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'cameras.view',
  'cameras.stream',
  'cameras.snapshot',
  'events.view',
  'recordings.view',
  'adguard.view',
  'system.view',
];

const OPERATOR: Permission[] = [
  ...VIEWER,
  'cameras.control.ptz',
  'cameras.control.light',
  'events.acknowledge',
  'adguard.protection.pause',
];

const ADMINISTRATOR: Permission[] = [
  ...OPERATOR,
  'cameras.control.siren',
  'cameras.control.privacy',
  'cameras.control.recording',
  'cameras.control.detection',
  'cameras.restart',
  'recordings.delete',
  'adguard.rules.write',
  'adguard.clients.write',
  'adguard.filters.write',
  'system.actions.run',
  'audit.view',
  'devices.manage',
  // Caddy and Authelia can take every site on the host offline, so these are
  // administrator-only and never granted to an operator.
  'infra.view',
  'infra.manage',
];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  operator: new Set(OPERATOR),
  administrator: new Set(ADMINISTRATOR),
};

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function atLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * Resolves the effective role from Authelia group membership.
 * Highest matching role wins. Returns null when no group maps — the user is
 * authenticated but not authorised, which is a 403, never a silent viewer.
 */
export function roleFromGroups(groups: string[], mapping: RoleMapping): Role | null {
  const set = new Set(groups.map((g) => g.trim().toLowerCase()).filter(Boolean));
  const has = (list: string[]): boolean => list.some((g) => set.has(g.trim().toLowerCase()));

  if (has(mapping.administrator)) return 'administrator';
  if (has(mapping.operator)) return 'operator';
  if (has(mapping.viewer)) return 'viewer';
  return null;
}

/** Startup sanity check for the configured mapping. */
export function validateRoleMapping(mapping: RoleMapping): string[] {
  const problems: string[] = [];
  const all = [...mapping.viewer, ...mapping.operator, ...mapping.administrator];
  if (all.length === 0) problems.push('No groups are mapped to any role.');
  const seen = new Map<string, string[]>();
  for (const [role, list] of Object.entries(mapping)) {
    for (const g of list as string[]) {
      const key = g.toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), role]);
    }
  }
  for (const [group, roles] of seen) {
    if (roles.length > 1) {
      problems.push(`Group "${group}" is mapped to multiple roles (${roles.join(', ')}).`);
    }
  }
  return problems;
}
