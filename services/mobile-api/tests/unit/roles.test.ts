import { describe, expect, it } from 'vitest';
import {
  atLeast,
  can,
  permissionsFor,
  roleFromGroups,
  validateRoleMapping,
} from '../../src/auth/roles.ts';

const mapping = {
  viewer: ['orionis-viewers'],
  operator: ['orionis-operators'],
  administrator: ['orionis-admins'],
};

describe('group to role mapping', () => {
  it('maps each configured group to its role', () => {
    expect(roleFromGroups(['orionis-viewers'], mapping)).toBe('viewer');
    expect(roleFromGroups(['orionis-operators'], mapping)).toBe('operator');
    expect(roleFromGroups(['orionis-admins'], mapping)).toBe('administrator');
  });

  it('grants the highest matching role when several apply', () => {
    expect(roleFromGroups(['orionis-viewers', 'orionis-admins'], mapping)).toBe('administrator');
    expect(roleFromGroups(['orionis-viewers', 'orionis-operators'], mapping)).toBe('operator');
  });

  it('is case and whitespace insensitive', () => {
    expect(roleFromGroups(['  Orionis-Admins '], mapping)).toBe('administrator');
  });

  it('returns null rather than defaulting to viewer for unmapped users', () => {
    expect(roleFromGroups(['some-other-group'], mapping)).toBeNull();
    expect(roleFromGroups([], mapping)).toBeNull();
  });
});

describe('permission matrix', () => {
  it('gives viewers read access only', () => {
    expect(can('viewer', 'cameras.view')).toBe(true);
    expect(can('viewer', 'adguard.view')).toBe(true);
    expect(can('viewer', 'adguard.protection.pause')).toBe(false);
    expect(can('viewer', 'cameras.control.ptz')).toBe(false);
    expect(can('viewer', 'events.acknowledge')).toBe(false);
    expect(can('viewer', 'recordings.delete')).toBe(false);
    expect(can('viewer', 'audit.view')).toBe(false);
  });

  it('gives operators acknowledgement, PTZ and a bounded protection pause', () => {
    expect(can('operator', 'events.acknowledge')).toBe(true);
    expect(can('operator', 'cameras.control.ptz')).toBe(true);
    expect(can('operator', 'adguard.protection.pause')).toBe(true);
    expect(can('operator', 'adguard.rules.write')).toBe(false);
    expect(can('operator', 'cameras.restart')).toBe(false);
    expect(can('operator', 'system.actions.run')).toBe(false);
  });

  it('gives administrators every permission', () => {
    for (const p of permissionsFor('administrator')) {
      expect(can('administrator', p)).toBe(true);
    }
    expect(can('administrator', 'audit.view')).toBe(true);
    expect(can('administrator', 'system.actions.run')).toBe(true);
  });

  it('is strictly cumulative across roles', () => {
    const viewer = new Set(permissionsFor('viewer'));
    const operator = new Set(permissionsFor('operator'));
    const admin = new Set(permissionsFor('administrator'));
    for (const p of viewer) expect(operator.has(p)).toBe(true);
    for (const p of operator) expect(admin.has(p)).toBe(true);
    expect(admin.size).toBeGreaterThan(operator.size);
    expect(operator.size).toBeGreaterThan(viewer.size);
  });

  it('ranks roles correctly', () => {
    expect(atLeast('administrator', 'viewer')).toBe(true);
    expect(atLeast('viewer', 'operator')).toBe(false);
    expect(atLeast('operator', 'operator')).toBe(true);
  });
});

describe('role mapping validation', () => {
  it('accepts a clean mapping', () => {
    expect(validateRoleMapping(mapping)).toEqual([]);
  });

  it('reports an empty mapping', () => {
    expect(validateRoleMapping({ viewer: [], operator: [], administrator: [] })).toContain(
      'No groups are mapped to any role.',
    );
  });

  it('reports a group mapped to more than one role', () => {
    const problems = validateRoleMapping({
      viewer: ['shared'],
      operator: [],
      administrator: ['shared'],
    });
    expect(problems.join(' ')).toContain('shared');
  });
});
