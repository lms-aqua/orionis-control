import { describe, expect, it } from 'vitest';
import type { AuditInput } from '../../src/audit/audit.ts';
import { AppError } from '../../src/lib/errors.ts';
import { auditMutation } from '../../src/routes/infra.ts';

const base: Omit<AuditInput, 'outcome' | 'reason'> = {
  action: 'infra.authelia.config_applied',
  actor: { id: 'u1', name: 'admin', role: 'administrator', deviceId: 'phone' },
  targetType: 'authelia',
  targetId: 'configuration',
  requestId: 'req_1',
};

describe('auditMutation', () => {
  it('records success only after the operation completes', async () => {
    const records: AuditInput[] = [];
    let completed = false;

    await auditMutation({ record: (entry) => records.push(entry) }, base, async () => {
      expect(records).toHaveLength(0);
      completed = true;
    });

    expect(completed).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'success', action: base.action });
  });

  it('records failure and rethrows the original error', async () => {
    const records: AuditInput[] = [];
    const failure = new AppError('UPSTREAM_UNAVAILABLE', 'Authelia did not respond.');

    await expect(
      auditMutation({ record: (entry) => records.push(entry) }, base, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: 'failure',
      reason: 'Authelia did not respond.',
      action: base.action,
    });
  });
});
