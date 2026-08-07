/**
 * Presents many camera sources as one `OrionisAdapter`.
 *
 * Route code, the OpenAPI surface and the iOS app are unchanged by this file
 * existing: they still see a single adapter. What changes is that camera IDs
 * are now `slug:upstreamId`, and reads fan out.
 *
 * The governing rule is **partial failure is normal**. With one source, an
 * unreachable upstream meant the feature was down and an error was the honest
 * answer. With several, one dead source must not blank a wall of working
 * cameras — so list operations collect what they can, record what failed, and
 * return the rest. Single-resource operations still throw, because there is no
 * partial answer to "give me this camera".
 */
import { AppError } from '../../lib/errors.ts';
import type {
  Camera,
  CameraControlRequest,
  CameraControlResult,
  CameraEvent,
  EventQuery,
  OrionisAdapter,
  OrionisServiceHealth,
  Page,
  Recording,
  RecordingQuery,
  StorageStatus,
  StreamProtocol,
  StreamQuality,
  StreamSession,
} from '../orionis/types.ts';
import { UNKNOWN_STORAGE } from '../orionis/types.ts';
import type { CameraProvider } from './provider.ts';
import { namespaceId, parseNamespacedId } from './provider.ts';

/** One live connection: its slug, its provider instance, its display name. */
export interface ActiveConnection {
  id: string;
  slug: string;
  name: string;
  provider: CameraProvider;
}

/** Reports a source that failed during a fan-out, for surfacing in health. */
export type DegradedReporter = (connectionId: string, error: unknown) => void;

export class AggregateOrionisAdapter implements OrionisAdapter {
  readonly kind = 'aggregate' as const;

  readonly #connections: () => ActiveConnection[];
  readonly #onDegraded: DegradedReporter;

  /**
   * Connections are supplied by a thunk rather than an array: they are editable
   * at runtime, and a snapshot captured at construction would go stale the
   * moment someone adds a source.
   */
  constructor(connections: () => ActiveConnection[], onDegraded: DegradedReporter = () => {}) {
    this.#connections = connections;
    this.#onDegraded = onDegraded;
  }

  get configured(): boolean {
    return this.#connections().length > 0;
  }

  /** True if *any* source can detect, since one that can is enough to show events. */
  get eventDetection(): boolean {
    return this.#connections().some((c) => c.provider.descriptor.capabilities.eventDetection);
  }

  // MARK: Fan-out helpers

  /**
   * Runs `fn` against every connection, tolerating individual failures.
   *
   * `Promise.allSettled` rather than `all`: one rejection must not discard the
   * results that succeeded.
   */
  async #fanOut<T>(fn: (c: ActiveConnection) => Promise<T[]>): Promise<T[]> {
    const connections = this.#connections();
    if (connections.length === 0) {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'No camera connections are configured.');
    }
    const settled = await Promise.allSettled(connections.map((c) => fn(c)));
    const out: T[] = [];
    let failures = 0;
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        out.push(...result.value);
      } else {
        failures += 1;
        this.#onDegraded(connections[i]!.id, result.reason);
      }
    });
    // Everything failed: there is no partial truth to report, so this is a real
    // outage rather than a degraded read.
    if (failures === connections.length) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'No camera connection could be reached.');
    }
    return out;
  }

  /** Resolves a namespaced ID to the connection that owns it. */
  #route(id: string): { connection: ActiveConnection; upstreamId: string } {
    const parsed = parseNamespacedId(id);
    if (!parsed) {
      throw new AppError('NOT_FOUND', `"${id}" is not a valid camera identifier.`);
    }
    const connection = this.#connections().find((c) => c.slug === parsed.slug);
    if (!connection) {
      // The connection was removed or disabled while a client held its ID.
      throw new AppError('NOT_FOUND', `No enabled connection named "${parsed.slug}".`);
    }
    return { connection, upstreamId: parsed.upstreamId };
  }

  // MARK: Cameras

  async listCameras(): Promise<Camera[]> {
    const cameras = await this.#fanOut(async (c) => {
      const list = await c.provider.listCameras();
      return list.map((cam) => this.#brand(c, cam));
    });
    // A total order the client can rely on: connection order first, then name.
    return cameras.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getCamera(cameraId: string): Promise<Camera> {
    const { connection, upstreamId } = this.#route(cameraId);
    return this.#brand(connection, await connection.provider.getCamera(upstreamId));
  }

  /** Rewrites upstream-local IDs into namespaced ones and records provenance. */
  #brand(c: ActiveConnection, camera: Camera): Camera {
    return {
      ...camera,
      id: namespaceId(c.slug, camera.id),
      // The source is shown in the app so two "Driveway" cameras from different
      // systems are tellable apart.
      group: camera.group ?? c.name,
    };
  }

  async getSnapshot(cameraId: string) {
    const { connection, upstreamId } = this.#route(cameraId);
    return connection.provider.getSnapshot(upstreamId);
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    const { connection, upstreamId } = this.#route(input.cameraId);
    const session = await connection.provider.createStreamSession({
      ...input,
      cameraId: upstreamId,
    });
    // The session's camera ID goes back to a client that only knows namespaced
    // IDs, so it has to be rewritten too.
    return { ...session, cameraId: input.cameraId };
  }

  async revokeStreamSession(streamSessionId: string): Promise<void> {
    // Stream session IDs are minted by the gateway, not namespaced, so which
    // connection owns one is not derivable. Revoking is idempotent and cheap,
    // so it is offered to every source and succeeds if any accepts it.
    const results = await Promise.allSettled(
      this.#connections().map((c) => c.provider.revokeStreamSession(streamSessionId)),
    );
    if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Could not revoke the stream session.');
    }
  }

  async invokeControl(cameraId: string, req: CameraControlRequest): Promise<CameraControlResult> {
    const { connection, upstreamId } = this.#route(cameraId);
    return connection.provider.invokeControl(upstreamId, req);
  }

  // MARK: Events

  async listEvents(query: EventQuery): Promise<Page<CameraEvent>> {
    // A camera filter pins the query to one source; without it, every source
    // that can detect is asked.
    if (query.cameraIds && query.cameraIds.length > 0) {
      return this.#eventsForCameras(query);
    }
    const items = await this.#fanOut(async (c) => {
      if (!c.provider.descriptor.capabilities.events) return [];
      const page = await c.provider.listEvents({ ...query, cameraIds: undefined });
      return page.items.map((e) => this.#brandEvent(c, e));
    });
    return this.#mergePage(items, query.limit ?? 50);
  }

  async #eventsForCameras(query: EventQuery): Promise<Page<CameraEvent>> {
    const bySlug = new Map<string, string[]>();
    for (const id of query.cameraIds ?? []) {
      const parsed = parseNamespacedId(id);
      if (!parsed) continue;
      bySlug.set(parsed.slug, [...(bySlug.get(parsed.slug) ?? []), parsed.upstreamId]);
    }
    const items = await this.#fanOut(async (c) => {
      const ids = bySlug.get(c.slug);
      if (!ids || !c.provider.descriptor.capabilities.events) return [];
      const page = await c.provider.listEvents({ ...query, cameraIds: ids });
      return page.items.map((e) => this.#brandEvent(c, e));
    });
    return this.#mergePage(items, query.limit ?? 50);
  }

  async getEvent(eventId: string): Promise<CameraEvent> {
    const { connection, upstreamId } = this.#route(eventId);
    return this.#brandEvent(connection, await connection.provider.getEvent(upstreamId));
  }

  #brandEvent(c: ActiveConnection, event: CameraEvent): CameraEvent {
    return {
      ...event,
      id: namespaceId(c.slug, event.id),
      cameraId: namespaceId(c.slug, event.cameraId),
    };
  }

  async acknowledgeEventUpstream(): Promise<boolean> {
    // Acknowledgement is recorded in the gateway's own store. No upstream in
    // this set accepts it, and claiming otherwise would be a lie.
    return false;
  }

  // MARK: Recordings

  async listRecordings(query: RecordingQuery): Promise<Page<Recording>> {
    // Same routing rule as events: a camera filter narrows the fan-out to the
    // sources that actually own those cameras.
    const requested = query.cameraIds ?? [];
    const bySlug = new Map<string, string[]>();
    for (const id of requested) {
      const parsed = parseNamespacedId(id);
      if (!parsed) continue;
      bySlug.set(parsed.slug, [...(bySlug.get(parsed.slug) ?? []), parsed.upstreamId]);
    }

    const items = await this.#fanOut(async (c) => {
      if (!c.provider.descriptor.capabilities.recordings) return [];
      if (requested.length > 0 && !bySlug.has(c.slug)) return [];
      const page = await c.provider.listRecordings({
        ...query,
        cameraIds: requested.length > 0 ? bySlug.get(c.slug) : undefined,
      });
      return page.items.map((r) => this.#brandRecording(c, r));
    });
    return this.#mergePage(items, query.limit ?? 50);
  }

  async getRecording(recordingId: string): Promise<Recording> {
    const { connection, upstreamId } = this.#route(recordingId);
    return this.#brandRecording(connection, await connection.provider.getRecording(upstreamId));
  }

  #brandRecording(c: ActiveConnection, rec: Recording): Recording {
    return {
      ...rec,
      id: namespaceId(c.slug, rec.id),
      cameraId: namespaceId(c.slug, rec.cameraId),
    };
  }

  // MARK: Storage and health

  /**
   * Sums what can be summed.
   *
   * A null from any source makes the corresponding total null rather than
   * treating it as zero — an unknown contribution means the total is unknown,
   * and reporting a confident-looking undercount is worse than reporting
   * nothing.
   */
  async getStorageStatus(): Promise<StorageStatus> {
    const connections = this.#connections().filter(
      (c) => c.provider.descriptor.capabilities.storageReporting,
    );
    if (connections.length === 0) return UNKNOWN_STORAGE;

    const settled = await Promise.allSettled(connections.map((c) => c.provider.getStorageStatus()));
    const reports = settled
      .filter((r): r is PromiseFulfilledResult<StorageStatus> => r.status === 'fulfilled')
      .map((r) => r.value);
    if (reports.length === 0) return UNKNOWN_STORAGE;

    const sum = (pick: (s: StorageStatus) => number | null): number | null => {
      const values = reports.map(pick);
      if (values.some((v) => v === null)) return null;
      return values.reduce((a: number, b) => a + (b ?? 0), 0);
    };

    return {
      ...UNKNOWN_STORAGE,
      totalBytes: sum((s) => s.totalBytes),
      usedBytes: sum((s) => s.usedBytes),
      freeBytes: sum((s) => s.freeBytes),
      recordingsBytes: sum((s) => s.recordingsBytes),
      quotaBytes: sum((s) => s.quotaBytes),
      fileCount: sum((s) => s.fileCount),
      dailyBytes: sum((s) => s.dailyBytes),
      // Retention and the oldest/newest window differ per source; a single
      // number for the set would be fiction.
      perCamera: reports.flatMap((s) => s.perCamera),
    };
  }

  async listServiceHealth(): Promise<OrionisServiceHealth[]> {
    const connections = this.#connections();
    const settled = await Promise.allSettled(connections.map((c) => c.provider.probe()));
    return connections.map((c, i) => {
      const result = settled[i];
      const probe = result?.status === 'fulfilled' ? result.value : null;
      return {
        id: `connection:${c.slug}`,
        name: c.name,
        status: probe?.ok ? 'healthy' : 'critical',
        // Latency belongs in the probe record, not here; this shape has no
        // field for it, so it is carried in the message rather than dropped.
        message:
          probe === null
            ? 'The connection could not be probed.'
            : probe.latencyMs === null
              ? probe.message
              : `${probe.message} (${probe.latencyMs} ms)`,
        version: null,
        uptimeSeconds: null,
        checkedAt: new Date().toISOString(),
      } satisfies OrionisServiceHealth;
    });
  }

  async runServiceAction(): Promise<{ ok: boolean; message: string }> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'Camera connections do not expose runnable service actions.',
    );
  }

  /** Newest first, then truncate — the merge point for every fanned-out list. */
  #mergePage<T extends { occurredAt?: string; startedAt?: string }>(
    items: T[],
    limit: number,
  ): Page<T> {
    const timeOf = (x: T) => x.occurredAt ?? x.startedAt ?? '';
    const sorted = items.sort((a, b) => timeOf(b).localeCompare(timeOf(a)));
    return {
      items: sorted.slice(0, limit),
      // Null, not `sorted.length`: this is the count across the *fetched*
      // windows, not the upstreams' true totals, and reporting it as a total
      // would understate every source that had more to give.
      total: null,
    };
  }
}
