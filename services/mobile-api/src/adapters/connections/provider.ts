/**
 * The camera-source plugin contract.
 *
 * A provider knows how to talk to one kind of upstream — Frigate, a bare RTSP
 * endpoint, lostblink. It is deliberately *narrower* than `OrionisAdapter`:
 * providers describe a single source and know nothing about how their cameras
 * are merged with anyone else's, or that merging happens at all. The aggregator
 * owns that, so adding a provider never means touching fan-out logic.
 *
 * Two rules carry over from `OrionisAdapter`, and matter more here because a
 * provider is easier to write badly:
 *
 *   1. Throw `CAPABILITY_UNSUPPORTED` for things the upstream genuinely cannot
 *      do. A bare RTSP URL has no event history; saying so is correct, and
 *      returning an empty page is a lie that reads as "nothing happened".
 *   2. Never synthesise plausible-looking data. An unknown value is null.
 */
import type {
  Camera,
  CameraControlRequest,
  CameraControlResult,
  CameraEvent,
  EventQuery,
  Page,
  Recording,
  RecordingQuery,
  StorageStatus,
  StreamProtocol,
  StreamQuality,
  StreamSession,
} from '../orionis/types.ts';

/** A field the operator fills in when creating a connection. */
export interface ProviderField {
  key: string;
  label: string;
  /** `secret` values are encrypted at rest and never returned by the API. */
  type: 'text' | 'url' | 'secret' | 'number' | 'boolean';
  required: boolean;
  placeholder?: string;
  /** Shown under the field. Explain consequences, not syntax. */
  help?: string;
  default?: string | number | boolean;
}

/**
 * What a provider can actually do.
 *
 * Declared up front rather than discovered by calling and catching, so the app
 * can hide a Recordings tab for a source that has none instead of offering it
 * and failing.
 */
export interface ProviderCapabilities {
  snapshots: boolean;
  liveStream: boolean;
  events: boolean;
  /** True only if the upstream itself detects objects/motion. */
  eventDetection: boolean;
  recordings: boolean;
  controls: boolean;
  storageReporting: boolean;
  /**
   * Whether this provider signs in interactively — credentials, then possibly a
   * mailed or texted code. Drives whether the app shows a Sign In button and a
   * verification step, so declaring it falsely strands the user on a screen
   * whose button does nothing.
   */
  interactiveAuth: boolean;
}

export interface ProviderDescriptor {
  /** Stable identifier persisted in `connections.provider`. Never rename. */
  readonly id: string;
  readonly displayName: string;
  readonly summary: string;
  readonly capabilities: ProviderCapabilities;
  readonly fields: ProviderField[];
}

/** Resolved configuration handed to a provider instance. */
export interface ProviderContext {
  connectionId: string;
  /** Slug that namespaces this connection's camera IDs. */
  slug: string;
  settings: Record<string, unknown>;
  /** Already decrypted. Never log this. */
  secrets: Record<string, string>;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  cameraCount: number | null;
  latencyMs: number | null;
}

/**
 * A second factor the upstream demands before it will finish signing in.
 *
 * Blink and Wyze both work this way: email and password are accepted, the
 * service then sends a PIN out of band and refuses to issue a token until it
 * comes back. Modelling this as a first-class step — rather than making the
 * operator paste a TOTP secret into a settings field — is what lets the app
 * show the same prompt the vendor's own app shows.
 */
export interface AuthChallenge {
  /** Opaque; the provider stores whatever partial state it needs against it. */
  challengeId: string;
  kind: 'emailed_code' | 'sms_code' | 'totp';
  /** Shown verbatim to the user. Say where the code went, not just "enter code". */
  prompt: string;
  /** Redacted destination, e.g. "p•••@gmail.com". Never the full address. */
  sentTo: string | null;
  expiresAt: string;
}

export type AuthResult =
  | { status: 'complete'; message: string }
  | { status: 'challenge'; challenge: AuthChallenge }
  | { status: 'failed'; message: string };

/**
 * Interactive sign-in, for upstreams that cannot be authenticated by config
 * alone.
 *
 * Optional: a Frigate URL behind a static API key needs none of this, and
 * implementing it would be pretence. `capabilities.interactiveAuth` declares
 * whether these exist so the app knows to offer a Sign In button.
 */
export interface InteractiveAuth {
  /**
   * Attempts a sign-in with the credentials already stored on the connection.
   * Returns a challenge when the upstream wants a second factor.
   */
  beginAuth(): Promise<AuthResult>;
  /** Submits the code the user received. */
  completeAuth(challengeId: string, code: string): Promise<AuthResult>;
  /**
   * Tokens obtained during sign-in that must be persisted back onto the
   * connection — returned rather than written, so the provider never needs a
   * database handle and the store stays the only writer.
   *
   * Only read once the flow reports `complete`: writing mid-challenge would
   * persist a half-authenticated state.
   */
  pendingSecrets(): Record<string, string>;

  /**
   * Non-secret facts learned during sign-in — an account id, a region tier.
   * Kept apart from `pendingSecrets` so they are not encrypted and reported as
   * credentials when they are neither.
   */
  pendingSettings(): Record<string, unknown>;
}

export function supportsInteractiveAuth(
  provider: CameraProvider,
): provider is CameraProvider & InteractiveAuth {
  return (
    typeof (provider as Partial<InteractiveAuth>).beginAuth === 'function' &&
    typeof (provider as Partial<InteractiveAuth>).completeAuth === 'function'
  );
}

/**
 * One configured upstream.
 *
 * Camera IDs returned here are *upstream-local* — the aggregator applies the
 * namespace prefix. A provider that prefixes its own IDs would double-prefix.
 */
export interface CameraProvider {
  readonly descriptor: ProviderDescriptor;

  /** Cheap reachability + credential check. Must not throw; report via `ok`. */
  probe(): Promise<ProbeResult>;

  listCameras(): Promise<Camera[]>;
  getCamera(cameraId: string): Promise<Camera>;
  getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }>;
  createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession>;
  revokeStreamSession(streamSessionId: string): Promise<void>;
  invokeControl(cameraId: string, req: CameraControlRequest): Promise<CameraControlResult>;
  listEvents(query: EventQuery): Promise<Page<CameraEvent>>;
  getEvent(eventId: string): Promise<CameraEvent>;
  listRecordings(query: RecordingQuery): Promise<Page<Recording>>;
  getRecording(recordingId: string): Promise<Recording>;
  getStorageStatus(): Promise<StorageStatus>;
}

export type ProviderFactory = (ctx: ProviderContext) => CameraProvider;

/**
 * The registry.
 *
 * Providers register themselves at module load; nothing else in the codebase
 * needs a list of them, so adding one is a single file plus one registration.
 */
export class ProviderRegistry {
  readonly #factories = new Map<
    string,
    { descriptor: ProviderDescriptor; create: ProviderFactory }
  >();

  register(descriptor: ProviderDescriptor, create: ProviderFactory): void {
    if (this.#factories.has(descriptor.id)) {
      throw new Error(`Provider "${descriptor.id}" is already registered.`);
    }
    this.#factories.set(descriptor.id, { descriptor, create });
  }

  has(id: string): boolean {
    return this.#factories.has(id);
  }

  descriptors(): ProviderDescriptor[] {
    return [...this.#factories.values()]
      .map((f) => f.descriptor)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  descriptor(id: string): ProviderDescriptor | null {
    return this.#factories.get(id)?.descriptor ?? null;
  }

  create(id: string, ctx: ProviderContext): CameraProvider {
    const entry = this.#factories.get(id);
    if (!entry) throw new Error(`Unknown provider "${id}".`);
    return entry.create(ctx);
  }
}

/**
 * Namespacing.
 *
 * Every ID crossing the gateway boundary is `slug:upstreamId`. Splitting on the
 * *first* colon only is deliberate: upstream IDs are outside our control and
 * frequently contain colons themselves.
 */
export function namespaceId(slug: string, upstreamId: string): string {
  return `${slug}:${upstreamId}`;
}

export function parseNamespacedId(id: string): { slug: string; upstreamId: string } | null {
  const idx = id.indexOf(':');
  if (idx <= 0 || idx === id.length - 1) return null;
  return { slug: id.slice(0, idx), upstreamId: id.slice(idx + 1) };
}

/** Lowercase, hyphenated, colon-free — colons would break `parseNamespacedId`. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
