/**
 * Guard rails for infrastructure changes made from the app.
 *
 * These exist because the blast radius here is unlike anything else in the
 * gateway. A bad Caddy config does not degrade a feature — it takes every site on
 * the host offline, including unrelated client sites and the gateway itself. And
 * if the gateway goes down, the app cannot be used to put it back: the tool and
 * the thing it repairs are the same box.
 *
 * So the rule these encode is narrow and absolute: **a change may not remove the
 * path the app itself depends on.** Everything else is the operator's business,
 * and is reported for confirmation rather than refused.
 *
 * All checks are text-level on purpose. Caddy accepts both a Caddyfile and a JSON
 * config, caddymanager passes either through, and a guard that only understood one
 * of them would be a guard that could be bypassed by sending the other.
 */
import { AppError } from './errors.ts';

export interface CaddyGuardInput {
  /** The configuration about to be applied, in whatever form it was submitted. */
  content: string;
  /** The gateway's own public hostname, e.g. `orionis-gateway.example.com`. */
  gatewayHost: string;
  /** The internal upstream the gateway is served from, e.g. `orionis-mobile-api:8080`. */
  gatewayUpstream: string;
}

/**
 * Refuses a Caddy config that would cut off the gateway.
 *
 * Deliberately checks for both the public hostname and the internal upstream: a
 * config could mention the hostname while routing it somewhere else, which fails
 * just as completely as omitting it.
 */
export function guardCaddyConfig(input: CaddyGuardInput): void {
  const content = input.content.trim();
  if (content.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'An empty configuration would take every site offline.',
    );
  }

  if (input.gatewayHost && !content.includes(input.gatewayHost)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `This configuration does not mention ${input.gatewayHost}, so applying it would ` +
        'disconnect this app from the server and leave no way to undo it from here.',
    );
  }

  // Host without upstream: reachable name, nothing behind it.
  if (input.gatewayUpstream && !content.includes(input.gatewayUpstream)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `This configuration does not route ${input.gatewayHost} to ${input.gatewayUpstream}, ` +
        'so this app would stop working the moment it is applied.',
    );
  }
}

/**
 * Hostnames mentioned by a configuration.
 *
 * Used to describe a change, not to authorise one — the diff is shown to the
 * operator so a removal is a decision rather than a surprise. It is intentionally
 * loose about how it finds them, because it has to cope with both config formats.
 */
export function extractHosts(content: string): string[] {
  const found = new Set<string>();
  const pattern = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\b/gi;
  for (const match of content.matchAll(pattern)) {
    const host = match[1]!.toLowerCase();
    // Skip things that look like a hostname but are not a site: file names,
    // container:port upstreams, version strings.
    if (/\.(ya?ml|json|conf|log|bak|crt|key|pem|txt|md|js|ts)$/.test(host)) continue;
    if (/^\d+(\.\d+)+$/.test(host)) continue;
    const tld = host.split('.').pop() ?? '';
    if (tld.length < 2 || /\d/.test(tld)) continue;
    found.add(host);
  }
  return [...found].sort();
}

export interface CaddyChangeSummary {
  removedHosts: string[];
  addedHosts: string[];
  /** True when the change drops a hostname that is currently being served. */
  removesLiveHosts: boolean;
}

export function summariseCaddyChange(current: string, proposed: string): CaddyChangeSummary {
  const before = new Set(extractHosts(current));
  const after = new Set(extractHosts(proposed));
  const removedHosts = [...before].filter((h) => !after.has(h)).sort();
  const addedHosts = [...after].filter((h) => !before.has(h)).sort();
  return { removedHosts, addedHosts, removesLiveHosts: removedHosts.length > 0 };
}

export interface AutheliaGuardInput {
  content: string;
  /** The OIDC client the app authenticates with, e.g. `orionis-control-mobile`. */
  oidcClientId: string;
}

/**
 * Refuses an Authelia config that would stop the app being able to sign in.
 *
 * Losing the OIDC client, or the claims policy it depends on, is not a
 * degradation: nobody can authenticate afterwards, and the app cannot be used to
 * restore the config that would fix it.
 */
export function guardAutheliaConfig(input: AutheliaGuardInput): void {
  const content = input.content.trim();
  if (content.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'An empty configuration would lock every user out of every protected site.',
    );
  }

  if (input.oidcClientId && !content.includes(input.oidcClientId)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `This configuration does not contain the "${input.oidcClientId}" OIDC client, so ` +
        'nobody could sign in to this app afterwards — including to undo the change.',
    );
  }

  // Authelia 4.38+ omits the groups claim from the id_token unless a claims policy
  // says otherwise, and the gateway reads groups from the id_token to decide a
  // user's role. Losing the policy makes every login land with no role at all,
  // which presents as "you are not a member of any permitted group".
  if (content.includes('identity_providers') && !content.includes('claims_policy')) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This configuration defines OIDC clients but no claims policy. Without one, ' +
        'group membership is left out of the token and every sign-in is refused as ' +
        'having no role.',
    );
  }
}
