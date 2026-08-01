/**
 * Short-lived TURN credentials for WebRTC.
 *
 * The VPS is behind provider NAT, so WebRTC media cannot reach go2rtc directly and
 * has to be relayed. The obvious way to secure a public relay port -- firewalling
 * it to one home IP address -- breaks the app on cellular and on every network
 * that is not that one, so it is not an option here.
 *
 * Instead the relay uses the standard TURN REST scheme (ADR 0004 s5): the username
 * *is* an expiry timestamp, and the password is an HMAC of it under a secret that
 * only ever exists server-side. Three consequences worth stating:
 *
 *   - A credential cannot be minted without the secret, so only an authenticated,
 *     authorised caller can obtain one.
 *   - A leaked credential expires on its own within minutes; nothing has to be
 *     revoked.
 *   - The relay itself is configured to forward only to go2rtc, so even a valid
 *     credential cannot be used as an open relay.
 */
import { createHmac } from 'node:crypto';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface TurnConfig {
  /** e.g. ["turn:203.0.113.10:16143?transport=udp"]. Empty disables TURN. */
  urls: string[];
  /** Shared with the TURN server as its static-auth-secret. Never sent to a client. */
  staticAuthSecret: string;
  /** How long a minted credential stays valid. */
  credentialTtlSeconds: number;
}

export interface TurnCredential {
  username: string;
  credential: string;
  expiresAt: string;
}

/**
 * Mints a credential for `subject`.
 *
 * The subject is embedded so relay sessions are attributable in the TURN server's
 * own log without it needing to know anything about our users. It must not contain
 * a colon, which separates the timestamp from the subject.
 */
export function mintTurnCredential(
  config: TurnConfig,
  subject: string,
  now: Date = new Date(),
): TurnCredential {
  const expiry = Math.floor(now.getTime() / 1000) + config.credentialTtlSeconds;
  const safeSubject = subject.replace(/[^A-Za-z0-9_-]/g, '') || 'user';
  const username = `${expiry}:${safeSubject}`;
  const credential = createHmac('sha1', config.staticAuthSecret).update(username).digest('base64');
  return { username, credential, expiresAt: new Date(expiry * 1000).toISOString() };
}

/**
 * ICE servers for a stream session, or an empty list when TURN is unconfigured —
 * a missing relay must degrade to "no WebRTC", never to an unauthenticated one.
 */
export function turnIceServers(
  config: TurnConfig,
  subject: string,
  now: Date = new Date(),
): IceServer[] {
  if (config.urls.length === 0 || !config.staticAuthSecret) return [];
  const { username, credential } = mintTurnCredential(config, subject, now);
  return [{ urls: [...config.urls], username, credential }];
}
