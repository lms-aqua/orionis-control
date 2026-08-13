/**
 * Registering a connection's RTSP stream with the site's go2rtc.
 *
 * Camera *sources* are per-connection; the media path is not. go2rtc is the
 * RTSP hub and the HLS packager pulls from it, and that pipeline is the one
 * that has been carrying cameras in production — WebRTC negotiation, the TURN
 * relay, the token-bound segment rewriting, all of it. A connection that
 * publishes RTSP somewhere else does not need a second copy of any of that; it
 * needs go2rtc to know where its stream is.
 *
 * So a bridge keeps publishing to wherever it publishes, and this points the
 * hub at it. One media path for every source, which is both less to run and
 * less to get wrong.
 *
 * Registration is lazy — it happens when someone actually opens a camera, not
 * when a connection is created. An idle bridge therefore costs nothing here,
 * and go2rtc only dials the source while a viewer is attached.
 */
import { AppError } from './errors.ts';

/** What go2rtc reports at `/api/streams`: a map of name to stream state. */
type Go2rtcStreams = Record<string, unknown>;

export interface RegisterOptions {
  /** The site go2rtc, e.g. `http://orionis-guard-go2rtc-1:1984`. */
  go2rtcBaseUrl: string;
  /** Stream name, which must match what the relay asks for. */
  name: string;
  /** The upstream the bridge publishes to, `rtsp://…`. */
  rtspUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Whether this is a source go2rtc can be pointed at.
 *
 * Only RTSP. A provider that already hands back an HTTP playlist or a WebRTC
 * endpoint is not something to re-plumb, and quietly registering one would
 * produce a stream that never carries anything.
 */
export function isRegisterableSource(playbackUrl: string | null | undefined): boolean {
  if (!playbackUrl) return false;
  if (!/^rtsps?:\/\//i.test(playbackUrl)) return false;
  return !carriesCredentials(playbackUrl);
}

/**
 * Whether a URL has a username or password in it.
 *
 * The ten direct-device providers put the camera login in the RTSP URL, because
 * RTSP has no other way to authenticate. That is safe on the terms those
 * providers state: the session is minted per request, handed only to an
 * authenticated caller, and never written down.
 *
 * Registering one here would write it down. go2rtc persists a registered stream
 * into its own config file — that is the property that makes registration
 * survive a restart, and the same property makes it a plaintext credential on
 * disk, in a group-readable file, copied into every backup of it.
 *
 * So a credentialed URL is not registerable. Such a camera keeps whatever
 * playback path it had before rather than gaining one at that price.
 */
function carriesCredentials(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.username !== '' || url.password !== '';
  } catch {
    // Unparseable is not registerable either: this decides whether to hand a
    // string to another service, and "I could not read it" is not a yes.
    return true;
  }
}

/**
 * Ensure `name` resolves in go2rtc, adding it if absent.
 *
 * Returns whether a registration was performed, so a caller can log the
 * transition without logging every subsequent playback.
 *
 * Failures here are deliberately not fatal to the caller: a stream that cannot
 * be registered fails at playback with the relay's own error, which is a better
 * message than one about an internal hub the user has never heard of.
 */
export async function ensureGo2rtcSource(options: RegisterOptions): Promise<boolean> {
  const { go2rtcBaseUrl, name, rtspUrl, timeoutMs } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const base = go2rtcBaseUrl.replace(/\/+$/, '');

  const existing = await doFetch(`${base}/api/streams`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!existing.ok) {
    throw new AppError('UPSTREAM_ERROR', `go2rtc returned HTTP ${existing.status}.`);
  }
  const streams = (await existing.json()) as Go2rtcStreams;
  if (Object.prototype.hasOwnProperty.call(streams, name)) return false;

  // PUT, not POST: go2rtc answers POST with 400 here. It writes the stream into
  // its own config file, so the registration survives a restart of the hub —
  // which is also why editing that file by hand does not work, and did not.
  const url =
    `${base}/api/streams?name=${encodeURIComponent(name)}` + `&src=${encodeURIComponent(rtspUrl)}`;
  const added = await doFetch(url, { method: 'PUT', signal: AbortSignal.timeout(timeoutMs) });
  if (!added.ok) {
    throw new AppError('UPSTREAM_ERROR', `go2rtc refused the stream (HTTP ${added.status}).`);
  }
  return true;
}
