import assert from 'node:assert/strict';
import test from 'node:test';

import { redactLogValue } from '../scrypted/log-redaction.mjs';

test('redacts nested Scrypted credentials without dropping diagnostics', () => {
  const redacted = redactLogValue({
    status: 200,
    authorization: 'Bearer live-access-token',
    queryToken: { scryptedToken: 'live-query-token' },
    nested: { address: 'https://scrypted.invalid', password: 'live-password' },
  });

  assert.deepEqual(redacted, {
    status: 200,
    authorization: '[REDACTED]',
    queryToken: '[REDACTED]',
    nested: { address: 'https://scrypted.invalid', password: '[REDACTED]' },
  });
});

test('redacts bearer credentials embedded in log strings', () => {
  assert.equal(
    redactLogValue('request failed: Authorization: Bearer abc123'),
    'request failed: Authorization: Bearer [REDACTED]',
  );
});
