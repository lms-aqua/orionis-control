/**
 * A minimal client for bropat/eufy-security-ws — the community WebSocket bridge
 * that wraps `eufy-security-client` and owns the Eufy cloud login, including the
 * captcha / 2FA dance. Orionis never holds a Eufy credential: it talks only to
 * the bridge, which is provisioned separately and signed in once by an operator.
 *
 * The bridge speaks a small JSON protocol (the same shape zwave-js-server uses,
 * which is what bropat modelled it on):
 *
 *   1. On connect the server sends `{ type: "version", maxSchemaVersion, … }`.
 *   2. The client pins a schema with `set_api_schema`.
 *   3. `start_listening` returns `{ result: { state: { devices, stations } } }`.
 *   4. Further commands (`device.get_properties`, `device.start_rtsp_livestream`)
 *      are correlated back to their reply by `messageId`.
 *
 * A session opens the socket, performs the handshake, runs one caller-supplied
 * function, and always closes — the provider makes a fresh session per request,
 * which keeps this stateless and side-effect-free between calls.
 *
 * This is verified against the bridge's documented protocol and by unit tests
 * with a scripted fake socket; it is not exercised against a live Eufy account
 * here, which is the one thing only an operator with the bridge can confirm.
 */

/** The subset of a Eufy device the provider reads. The bridge sends many more
 * fields; only these are consumed, and all are optional because they vary by
 * model and schema version. */
export interface EufyWsDevice {
  serialNumber: string;
  name?: string;
  model?: string;
  type?: number;
  rtspStream?: boolean;
  rtspStreamUrl?: string;
  pictureUrl?: string;
  [key: string]: unknown;
}

export type WsEventType = 'open' | 'message' | 'error' | 'close';

/** The minimal WebSocket surface used here, so a fake can stand in for tests.
 * A single signature (rather than per-type overloads) keeps fakes trivial to
 * type; `data` is only present on `message` events and ignored otherwise. */
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: WsEventType, listener: (ev: { data?: unknown }) => void): void;
}

export type WebSocketCtor = new (url: string) => MinimalWebSocket;

/** Highest schema that still inlines `pictureUrl`/`rtspStreamUrl` on the device
 * (they were reworked at schema 13), so pinning at or below it keeps snapshot
 * and stream URLs readable straight from `start_listening`. */
const PREFERRED_SCHEMA = 12;

interface VersionMessage {
  type: 'version';
  minSchemaVersion?: number;
  maxSchemaVersion?: number;
}

export class EufyWsError extends Error {}

export class EufyWsSession {
  #ws: MinimalWebSocket;
  #nextId = 1;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #versionResolve: ((v: VersionMessage) => void) | null = null;
  #version: Promise<VersionMessage>;
  #closed = false;

  private constructor(ws: MinimalWebSocket) {
    this.#ws = ws;
    this.#version = new Promise<VersionMessage>((resolve) => {
      this.#versionResolve = resolve;
    });
    ws.addEventListener('message', (ev: { data?: unknown }) => this.#onMessage(ev.data));
  }

  #onMessage(data: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return; // Non-JSON frames are not part of this protocol.
    }
    const record = msg as {
      type?: string;
      messageId?: unknown;
      success?: boolean;
      result?: unknown;
      errorCode?: string;
    };
    if (record.type === 'version') {
      this.#versionResolve?.(record as VersionMessage);
      this.#versionResolve = null;
      return;
    }
    if (record.type === 'result' && typeof record.messageId === 'string') {
      const waiter = this.#pending.get(record.messageId);
      if (!waiter) return; // A reply we are no longer waiting for.
      this.#pending.delete(record.messageId);
      if (record.success) waiter.resolve(record.result);
      else waiter.reject(new EufyWsError(record.errorCode ?? 'The bridge rejected the request.'));
      return;
    }
    // Everything else (type: "event") is state churn this request ignores.
  }

  #command(command: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(new EufyWsError('The bridge session is closed.'));
    const messageId = `orionis-${this.#nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(messageId, { resolve, reject });
      this.#ws.send(JSON.stringify({ command, messageId, ...extra }));
    });
  }

  /** Opens a socket, performs the handshake, runs `fn`, and always closes. */
  static async run<T>(
    wsUrl: string,
    timeoutMs: number,
    ctor: WebSocketCtor,
    fn: (session: EufyWsSession) => Promise<T>,
  ): Promise<T> {
    const ws = new ctor(wsUrl);
    const session = new EufyWsSession(ws);
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new EufyWsError('The Eufy bridge did not respond in time.')),
        timeoutMs,
      );
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });

    const opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () =>
        reject(new EufyWsError('The Eufy bridge could not be reached.')),
      );
      ws.addEventListener('close', () => {
        if (!session.#closed) reject(new EufyWsError('The Eufy bridge closed the connection.'));
      });
    });

    const work = (async (): Promise<T> => {
      await opened;
      const version = await session.#version;
      const min = version.minSchemaVersion ?? 0;
      const max = version.maxSchemaVersion ?? PREFERRED_SCHEMA;
      const schemaVersion = Math.max(min, Math.min(PREFERRED_SCHEMA, max));
      await session.#command('set_api_schema', { schemaVersion });
      return fn(session);
    })();

    try {
      return await Promise.race([work, timeout]);
    } finally {
      session.#close();
    }
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#pending.values()) {
      waiter.reject(new EufyWsError('The bridge session closed before replying.'));
    }
    this.#pending.clear();
    try {
      this.#ws.close();
    } catch {
      // Already closing; nothing to do.
    }
  }

  /** Lists the devices the bridge currently knows about. */
  async listDevices(): Promise<EufyWsDevice[]> {
    const result = (await this.#command('start_listening')) as {
      state?: { devices?: EufyWsDevice[] };
    };
    return result?.state?.devices ?? [];
  }

  /** Reads a device's current properties (values map). */
  async getProperties(serialNumber: string): Promise<Record<string, unknown>> {
    const result = (await this.#command('device.get_properties', { serialNumber })) as {
      properties?: Record<string, unknown>;
    };
    return result?.properties ?? {};
  }

  /** Asks the bridge to start the device's local RTSP stream. */
  async startRtsp(serialNumber: string): Promise<void> {
    await this.#command('device.start_rtsp_livestream', { serialNumber });
  }
}
