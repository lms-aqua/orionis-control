/**
 * Credential encryption at rest.
 *
 * These are recoverable secrets — the gateway has to present the original value
 * upstream — so the properties that matter are: the ciphertext is unreadable
 * without the key, tampering is detected rather than silently accepted, and a
 * key rotation has a path that does not orphan every stored credential.
 */
import { describe, expect, it } from 'vitest';
import { SecretsCipher, SecretsCipherError, redactSecrets } from '../../src/lib/secrets.ts';

const KEY_A = 'a'.repeat(48);
const KEY_B = 'b'.repeat(48);

describe('SecretsCipher', () => {
  it('round-trips a value', () => {
    const cipher = new SecretsCipher(KEY_A);
    const encoded = cipher.encrypt('hunter2-but-longer');
    expect(cipher.decrypt(encoded)).toBe('hunter2-but-longer');
  });

  it('never emits the plaintext in the ciphertext', () => {
    const cipher = new SecretsCipher(KEY_A);
    expect(cipher.encrypt('driveway-token')).not.toContain('driveway-token');
  });

  it('uses a fresh IV per encryption, so equal values do not look equal', () => {
    // Two identical credentials stored under one key must not be visibly
    // identical in the database, and IV reuse would destroy GCM entirely.
    const cipher = new SecretsCipher(KEY_A);
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('refuses a key too short to be worth having', () => {
    expect(() => new SecretsCipher('short')).toThrow(SecretsCipherError);
  });

  it('rejects a tampered ciphertext rather than returning altered data', () => {
    const cipher = new SecretsCipher(KEY_A);
    const [version, iv, tag, data] = cipher.encrypt('original').split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64url')].join('.');
    expect(() => cipher.decrypt(tampered)).toThrow(SecretsCipherError);
  });

  it('rejects a value written under an unrelated key', () => {
    const written = new SecretsCipher(KEY_A).encrypt('value');
    expect(() => new SecretsCipher(KEY_B).decrypt(written)).toThrow(SecretsCipherError);
  });

  it('rejects a malformed envelope', () => {
    const cipher = new SecretsCipher(KEY_A);
    expect(() => cipher.decrypt('not-even-close')).toThrow(SecretsCipherError);
    expect(() => cipher.decrypt('v1.a.b')).toThrow(SecretsCipherError);
  });

  describe('rotation', () => {
    it('still decrypts values written under a retired key', () => {
      const old = new SecretsCipher(KEY_A).encrypt('kept');
      const rotated = new SecretsCipher(KEY_B, [KEY_A]);
      expect(rotated.decrypt(old)).toBe('kept');
    });

    it('flags exactly the values that would break when the old key is dropped', () => {
      const rotated = new SecretsCipher(KEY_B, [KEY_A]);
      const legacy = new SecretsCipher(KEY_A).encrypt('kept');
      expect(rotated.needsRewrap(legacy)).toBe(true);
      expect(rotated.needsRewrap(rotated.encrypt('fresh'))).toBe(false);
    });

    it('rewraps a legacy value so the retired key can be removed', () => {
      const legacy = new SecretsCipher(KEY_A).encrypt('kept');
      const rotated = new SecretsCipher(KEY_B, [KEY_A]);
      const rewrapped = rotated.rewrap(legacy);

      // Readable with the new key alone — which is the whole point.
      expect(new SecretsCipher(KEY_B).decrypt(rewrapped)).toBe('kept');
      expect(rotated.needsRewrap(rewrapped)).toBe(false);
    });
  });

  it('encrypts every value of a bag while leaving the keys legible', () => {
    const cipher = new SecretsCipher(KEY_A);
    const bag = cipher.encryptRecord({ apiKey: 'one', token: 'two' });
    expect(Object.keys(bag).sort()).toEqual(['apiKey', 'token']);
    expect(bag.apiKey).not.toBe('one');
    expect(cipher.decryptRecord(bag)).toEqual({ apiKey: 'one', token: 'two' });
  });
});

describe('redactSecrets', () => {
  it('reports presence only — never the value, never the length', () => {
    const redacted = redactSecrets({ apiKey: 'a-very-long-credential', pin: '1234' });
    expect(redacted).toEqual({ apiKey: true, pin: true });
    // Length is a real leak: it narrows a guess more than it looks like it does.
    expect(JSON.stringify(redacted)).not.toMatch(/\d/);
  });
});
