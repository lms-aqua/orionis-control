/**
 * Symmetric encryption for third-party credentials held at rest.
 *
 * Connections store credentials for systems this gateway does not own — a
 * Frigate instance, a Blink account, an RTSP source. Those are *recoverable*
 * secrets: unlike a session token, the gateway has to present the original
 * value upstream, so they cannot be hashed. They are therefore encrypted with
 * AES-256-GCM under a key that lives only in the environment, so a stolen
 * database file is not by itself a stolen Blink account.
 *
 * GCM is authenticated: a tampered ciphertext fails to decrypt rather than
 * silently yielding altered credentials. The IV is random per encryption and
 * stored alongside, which is required — reusing an IV under one key destroys
 * GCM's security entirely.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.
const TAG_BYTES = 16;
const VERSION = 'v1';

export class SecretsCipherError extends Error {}

/**
 * Wraps the configured key. Constructed once at the composition root so a
 * missing or malformed key fails at boot rather than on first use.
 *
 * A *previous* key may be supplied as well. It is only ever used to decrypt, so
 * rotating the key is: set the new one as primary, move the old one to
 * previous, restart, run `npm run secrets:rewrap`, then drop the previous key.
 * Without that path, rotating the key silently orphans every stored credential
 * and the only recovery is retyping them all.
 */
export class SecretsCipher {
  readonly #key: Buffer;
  readonly #previousKeys: Buffer[];

  constructor(rawKey: string, previousKeys: string[] = []) {
    if (!rawKey || rawKey.trim().length < 32) {
      throw new SecretsCipherError(
        'CONNECTIONS_SECRET_KEY must be at least 32 characters. Generate one with: openssl rand -base64 48',
      );
    }
    // Hashing to exactly 32 bytes lets the operator supply any sufficiently
    // long passphrase without having to produce exactly 256 bits themselves.
    this.#key = createHash('sha256').update(rawKey, 'utf8').digest();
    this.#previousKeys = previousKeys
      .filter((k) => k && k.trim().length >= 32)
      .map((k) => createHash('sha256').update(k, 'utf8').digest());
  }

  /** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join('.');
  }

  decrypt(encoded: string): string {
    return this.#open(encoded).plaintext;
  }

  /**
   * True when the value still decrypts, but only under a retired key — i.e. it
   * is readable today and unreadable as soon as that key is removed.
   */
  needsRewrap(encoded: string): boolean {
    return !this.#open(encoded).underPrimary;
  }

  /** Re-encrypts a value under the primary key. */
  rewrap(encoded: string): string {
    return this.encrypt(this.decrypt(encoded));
  }

  #open(encoded: string): { plaintext: string; underPrimary: boolean } {
    const parts = encoded.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new SecretsCipherError('Ciphertext is not in the expected v1 format.');
    }
    const [, ivPart, tagPart, dataPart] = parts;
    const iv = unb64(ivPart!);
    const tag = unb64(tagPart!);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretsCipherError('Ciphertext IV or authentication tag has the wrong length.');
    }
    const data = unb64(dataPart!);

    const keys = [this.#key, ...this.#previousKeys];
    for (const [index, key] of keys.entries()) {
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        return { plaintext, underPrimary: index === 0 };
      } catch {
        // GCM authentication failed under this key. Try the next one; only when
        // every key fails is the value genuinely unreadable.
      }
    }
    // Either no configured key matches or the row was tampered with. Both are
    // the same problem from here: this value cannot be trusted or used.
    throw new SecretsCipherError(
      'Could not decrypt stored credential. The encryption key may have changed — set the old key as CONNECTIONS_SECRET_KEY_PREVIOUS and run the rewrap script.',
    );
  }

  /**
   * Encrypts every value of a credential bag. Keys stay in the clear so the
   * shape of a connection remains inspectable without the key.
   */
  encryptRecord(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, this.encrypt(v)]));
  }

  decryptRecord(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, this.decrypt(v)]));
  }
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/**
 * What the API is allowed to say about a stored secret.
 *
 * Never the value, and never the length — length leaks more about a password
 * than it looks like it does. Only whether something is set.
 */
export function redactSecrets(values: Record<string, string>): Record<string, boolean> {
  return Object.fromEntries(Object.keys(values).map((k) => [k, true]));
}
