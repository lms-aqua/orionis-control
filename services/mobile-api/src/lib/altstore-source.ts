/**
 * Serves the AltStore/SideStore source document reliably.
 *
 * AltStore fetching the source straight from a GitHub release asset was fragile:
 * every CI build re-uploads that asset, and during the upload window the URL can
 * 404 or return partial bytes — which AltStore reports as "the data couldn't be
 * read because it isn't in the correct format" (a JSON parse failure).
 *
 * The gateway sits in front of it: it fetches the upstream document, validates
 * that it actually parses as JSON, caches the last good copy, and always serves
 * that. If GitHub is mid-upload the validation fails and the previous good copy
 * is served instead, so a client never sees a broken source. The IPA itself
 * still comes from GitHub (versioned filenames, so no stale-CDN hash mismatch);
 * only the small, load-bearing source document is fronted here.
 */
const SOURCE_URL =
  'https://github.com/lms-aqua/orionis-control/releases/download/ios_latest/altstore-source.json';
const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

let cache: { body: string; at: number } | null = null;
let inflight: Promise<void> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetches and validates the upstream source, retrying across an upload window. */
async function fetchValid(fetchImpl: typeof fetch, attempts = 3): Promise<string> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetchImpl(SOURCE_URL, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`upstream status ${res.status}`);
      const text = await res.text();
      JSON.parse(text); // Throws on a partial body or a 404 HTML page.
      return text;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await sleep(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('source fetch failed');
}

/**
 * Returns the AltStore source JSON as a string. Serves a cached copy within the
 * TTL; otherwise refreshes (single-flight) and falls back to the last good copy
 * if the refresh fails. Throws only if nothing valid has ever been fetched.
 */
export async function getAltstoreSource(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.body;

  if (!inflight) {
    inflight = fetchValid(fetchImpl)
      .then((body) => {
        cache = { body, at: Date.now() };
      })
      .catch(() => {
        // Keep serving the last good copy; do not poison the cache.
      })
      .finally(() => {
        inflight = null;
      });
  }
  await inflight;

  if (cache) return cache.body;
  throw new Error('AltStore source is not available yet');
}
