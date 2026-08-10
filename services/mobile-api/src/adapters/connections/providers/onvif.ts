/**
 * Generic ONVIF Profile S cameras.
 *
 * ONVIF is a vendor-neutral standard rather than a brand, so this one provider
 * reaches the long tail that has no bespoke connector — Axis, Uniview, Vivotek,
 * Bosch, Amcrest's ONVIF mode, and the many white-label cameras that all speak
 * the same SOAP. It talks to the camera's local ONVIF service, discovers the
 * media profiles, and asks the camera itself for its RTSP stream URI and JPEG
 * snapshot URI — so it works without knowing the vendor's private paths.
 *
 * Authentication is the WS-Security UsernameToken the standard defines: a
 * password digest over a per-request nonce and timestamp, never the password in
 * the clear. Snapshot URIs the camera hands back are then fetched with ordinary
 * HTTP Digest, which is what most ONVIF cameras protect them with.
 *
 * Events and recordings are their own ONVIF profiles (Profile G/M) with far
 * patchier real-world support; this provider covers Profile S — live video and
 * snapshots — which is the part every ONVIF camera implements the same way.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../../lib/errors.ts';
import { fetchWithDigest } from '../../../lib/http-digest.ts';
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
} from '../../orionis/types.ts';
import { UNKNOWN_STORAGE } from '../../orionis/types.ts';
import type {
  CameraProvider,
  ProviderContext,
  ProviderDescriptor,
  ProbeResult,
} from '../provider.ts';

export const ONVIF_DESCRIPTOR: ProviderDescriptor = {
  id: 'onvif',
  displayName: 'ONVIF (generic)',
  summary:
    'Any ONVIF Profile S camera on your network, whatever the brand. The camera is asked for its own stream and snapshot URLs, so no vendor-specific setup is needed. Live view and snapshots.',
  capabilities: {
    snapshots: true,
    liveStream: true,
    events: false,
    eventDetection: false,
    recordings: false,
    controls: false,
    storageReporting: false,
    interactiveAuth: false,
  },
  fields: [
    {
      key: 'baseUrl',
      label: 'Camera address',
      type: 'url',
      required: true,
      placeholder: 'http://192.168.1.90',
      help: 'The camera on your network. Include the ONVIF port if it is not 80, e.g. http://192.168.1.90:8000.',
    },
    {
      key: 'displayName',
      label: 'Camera name',
      type: 'text',
      required: false,
      placeholder: 'Side Gate',
      help: 'What this camera is called in the app. Defaults to the connection name.',
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      required: true,
      placeholder: 'admin',
      help: 'An ONVIF user on the camera. Many cameras need ONVIF turned on and a user created for it.',
    },
    {
      key: 'password',
      label: 'Password',
      type: 'secret',
      required: true,
      help: 'Stored encrypted. Used only to reach the camera on your network.',
    },
    {
      key: 'profileToken',
      label: 'Profile',
      type: 'text',
      required: false,
      advanced: true,
      help: 'Which media profile to stream. Leave blank to use the camera’s first profile.',
    },
    {
      key: 'devicePath',
      label: 'ONVIF device path',
      type: 'text',
      required: false,
      default: '/onvif/device_service',
      advanced: true,
      help: 'The ONVIF service path. The default suits almost every camera.',
    },
  ],
};

const NS = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
} as const;

const PW_DIGEST_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

/**
 * The WS-Security password digest: Base64(SHA1(nonce · created · password)).
 *
 * Split out and given its inputs so it can be pinned against a known vector
 * without a live camera; `created` and `nonce` are otherwise per-request.
 */
export function wsseDigest(nonce: Buffer, created: string, password: string): string {
  return createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
    .digest('base64');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** First `<*:Uri>…</*:Uri>` text, namespace prefix ignored. */
function extractUri(xml: string): string | null {
  const m = /<(?:\w+:)?Uri>\s*([^<]+?)\s*<\/(?:\w+:)?Uri>/i.exec(xml);
  return m?.[1]?.trim() ?? null;
}

export class OnvifProvider implements CameraProvider {
  readonly descriptor = ONVIF_DESCRIPTOR;
  readonly #ctx: ProviderContext;
  #mediaXAddr: string | null = null;

  constructor(ctx: ProviderContext) {
    this.#ctx = ctx;
  }

  get #baseUrl(): URL {
    const raw = String(this.#ctx.settings.baseUrl ?? '').trim();
    if (!raw) throw new AppError('SERVICE_NOT_CONFIGURED', 'No camera address is set.');
    try {
      return new URL(raw);
    } catch {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The camera address is not a valid URL.');
    }
  }

  get #username(): string {
    return String(this.#ctx.settings.username ?? '').trim();
  }

  get #devicePath(): string {
    const raw = String(this.#ctx.settings.devicePath ?? '/onvif/device_service').trim();
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  get #cameraId(): string {
    return 'camera';
  }

  #deviceServiceUrl(): string {
    const url = new URL(this.#baseUrl.toString());
    url.pathname = this.#devicePath;
    return url.toString();
  }

  /** Builds the SOAP security header afresh for each call, as ONVIF requires. */
  #securityHeader(): string {
    const nonce = randomBytes(16);
    const created = new Date().toISOString();
    const digest = wsseDigest(nonce, created, this.#ctx.secrets.password ?? '');
    return (
      `<s:Header>` +
      `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" s:mustUnderstand="1">` +
      `<wsse:UsernameToken>` +
      `<wsse:Username>${xmlEscape(this.#username)}</wsse:Username>` +
      `<wsse:Password Type="${PW_DIGEST_TYPE}">${digest}</wsse:Password>` +
      `<wsse:Nonce EncodingType="${BASE64_TYPE}">${nonce.toString('base64')}</wsse:Nonce>` +
      `<wsu:Created>${created}</wsu:Created>` +
      `</wsse:UsernameToken>` +
      `</wsse:Security>` +
      `</s:Header>`
    );
  }

  async #soap(endpoint: string, action: string, body: string): Promise<string> {
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<s:Envelope xmlns:s="${NS.soap}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tt="${NS.tt}">` +
      this.#securityHeader() +
      `<s:Body>${body}</s:Body>` +
      `</s:Envelope>`;
    const response = await this.#ctx.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': `application/soap+xml; charset=utf-8; action="${action}"`,
      },
      body: envelope,
      signal: AbortSignal.timeout(this.#ctx.timeoutMs),
    });
    const text = await response.text();
    if (response.status === 401) {
      throw new AppError('UPSTREAM_ERROR', 'unauthorised');
    }
    if (!response.ok) {
      // A SOAP fault often carries a NotAuthorized subcode even under HTTP 500.
      if (/NotAuthorized|not authorized|Sender not authorized/i.test(text)) {
        throw new AppError('UPSTREAM_ERROR', 'unauthorised');
      }
      throw new AppError('UPSTREAM_ERROR', `HTTP ${response.status}`);
    }
    return text;
  }

  /** Discovers the Media service address, falling back to the usual path. */
  async #mediaEndpoint(): Promise<string> {
    if (this.#mediaXAddr) return this.#mediaXAddr;
    try {
      const xml = await this.#soap(
        this.#deviceServiceUrl(),
        `${NS.tds}/GetServices`,
        `<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>`,
      );
      // GetServices lists each service as a Namespace followed by its XAddr.
      const re =
        /<(?:\w+:)?Namespace>([^<]*media\/wsdl)<\/(?:\w+:)?Namespace>\s*<(?:\w+:)?XAddr>([^<]+)<\/(?:\w+:)?XAddr>/i;
      const m = re.exec(xml);
      if (m?.[2]) {
        this.#mediaXAddr = this.#rehostXAddr(m[2].trim());
        return this.#mediaXAddr;
      }
    } catch {
      // Discovery is best-effort; fall through to the conventional path.
    }
    const fallback = new URL(this.#baseUrl.toString());
    fallback.pathname = '/onvif/Media';
    this.#mediaXAddr = fallback.toString();
    return this.#mediaXAddr;
  }

  /**
   * Cameras report XAddrs with their own idea of their address, which is often
   * an internal hostname or a `0.0.0.0`. The host we were told to reach is the
   * one that actually routes, so keep it and take only the path.
   */
  #rehostXAddr(xaddr: string): string {
    try {
      const reported = new URL(xaddr);
      const base = new URL(this.#baseUrl.toString());
      base.pathname = reported.pathname;
      return base.toString();
    } catch {
      return xaddr;
    }
  }

  async #profileTokens(): Promise<string[]> {
    const xml = await this.#soap(
      await this.#mediaEndpoint(),
      `${NS.trt}/GetProfiles`,
      `<trt:GetProfiles/>`,
    );
    const tokens: string[] = [];
    const re = /<(?:\w+:)?Profiles\b[^>]*\btoken="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) tokens.push(m[1]!);
    return tokens;
  }

  async #chosenProfile(): Promise<string> {
    const configured = String(this.#ctx.settings.profileToken ?? '').trim();
    if (configured) return configured;
    const tokens = await this.#profileTokens();
    if (tokens.length === 0) {
      throw new AppError('UPSTREAM_ERROR', 'The camera reported no media profiles.');
    }
    return tokens[0]!;
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    if (!this.#username || !this.#ctx.secrets.password) {
      return {
        ok: false,
        message: 'A username and password are required.',
        cameraCount: null,
        latencyMs: null,
      };
    }
    try {
      const tokens = await this.#profileTokens();
      return {
        ok: true,
        message:
          tokens.length > 0
            ? `Reached the camera; ${tokens.length} media profile(s) available.`
            : 'Reached the camera, but it reported no media profiles.',
        cameraCount: tokens.length > 0 ? 1 : 0,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreachable';
      if (message === 'unauthorised') {
        return {
          ok: false,
          message: 'The camera rejected the ONVIF login. Check the username and password.',
          cameraCount: null,
          latencyMs: Date.now() - started,
        };
      }
      return {
        ok: false,
        message: 'The camera could not be reached over ONVIF.',
        cameraCount: null,
        latencyMs: Date.now() - started,
      };
    }
  }

  async listCameras(): Promise<Camera[]> {
    let reachable = false;
    try {
      reachable = (await this.#profileTokens()).length > 0;
    } catch {
      reachable = false;
    }
    return [this.#camera(reachable)];
  }

  async getCamera(cameraId: string): Promise<Camera> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    return (await this.listCameras())[0]!;
  }

  #camera(reachable: boolean): Camera {
    const configured = String(this.#ctx.settings.displayName ?? '').trim();
    return {
      id: this.#cameraId,
      name: configured || 'ONVIF camera',
      location: null,
      group: null,
      model: 'ONVIF',
      firmware: null,
      capabilities: {
        // ONVIF PTZ is a separate profile with uneven support; not exposed here.
        ptz: false,
        presets: false,
        zoom: false,
        light: false,
        siren: false,
        privacyMode: false,
        twoWayAudio: false,
        audio: null,
        recordingToggle: false,
        motionToggle: false,
        sensitivity: false,
        restart: false,
        snapshot: true,
        protocols: ['hls'],
        qualities: ['auto'],
      },
      health: {
        status: reachable ? 'online' : 'unknown',
        recording: null,
        streaming: false,
        motionDetected: false,
        privacyEnabled: false,
        lastSeenAt: null,
        signalQuality: null,
        bitrateKbps: null,
        frameRate: null,
        resolution: null,
        message: reachable ? null : 'Health is checked when the connection is probed.',
      },
      snapshotPath: null,
    };
  }

  async getSnapshot(
    cameraId: string,
  ): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    if (cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    const token = await this.#chosenProfile();
    const xml = await this.#soap(
      await this.#mediaEndpoint(),
      `${NS.trt}/GetSnapshotUri`,
      `<trt:GetSnapshotUri><trt:ProfileToken>${xmlEscape(token)}</trt:ProfileToken></trt:GetSnapshotUri>`,
    );
    const uri = extractUri(xml);
    if (!uri) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'This camera does not offer an ONVIF snapshot.');
    }
    // The snapshot URI is nearly always HTTP behind Digest with the same
    // credentials; the host is rewritten so an internally-reported address
    // still routes.
    const response = await fetchWithDigest(this.#ctx.fetchImpl, this.#rehostXAddr(uri), {
      username: this.#username,
      password: this.#ctx.secrets.password ?? '',
      timeoutMs: this.#ctx.timeoutMs,
    });
    if (!response.ok) {
      throw new AppError('CAMERA_OFFLINE', `Could not capture a frame (HTTP ${response.status}).`);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'image/jpeg',
      capturedAt: new Date().toISOString(),
    };
  }

  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: StreamProtocol[];
    quality: StreamQuality;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    if (input.cameraId !== this.#cameraId) throw AppError.notFound('Camera');
    const password = this.#ctx.secrets.password ?? '';
    if (!this.#username || !password) {
      throw new AppError('SERVICE_NOT_CONFIGURED', 'The ONVIF login is incomplete.');
    }
    const token = await this.#chosenProfile();
    const xml = await this.#soap(
      await this.#mediaEndpoint(),
      `${NS.trt}/GetStreamUri`,
      `<trt:GetStreamUri>` +
        `<trt:StreamSetup>` +
        `<tt:Stream>RTP-Unicast</tt:Stream>` +
        `<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>` +
        `</trt:StreamSetup>` +
        `<trt:ProfileToken>${xmlEscape(token)}</trt:ProfileToken>` +
        `</trt:GetStreamUri>`,
    );
    const uri = extractUri(xml);
    if (!uri) {
      throw new AppError('UPSTREAM_ERROR', 'The camera did not return a stream URL.');
    }
    // The camera returns an RTSP URL without credentials; inject them so the
    // relay can open it. Credentials go in the URL because RTSP has no other
    // way to authenticate; the session is minted per request, returned only to
    // an authenticated caller, and never logged.
    let playbackUrl = uri;
    try {
      const parsed = new URL(uri);
      const base = new URL(this.#baseUrl.toString());
      // Keep the camera's stream path and port, but route to the host we can
      // actually reach and add the credentials.
      parsed.hostname = base.hostname;
      parsed.username = encodeURIComponent(this.#username);
      parsed.password = encodeURIComponent(password);
      playbackUrl = parsed.toString();
    } catch {
      // A URL we cannot parse is handed back as-is rather than dropped.
    }

    return {
      id: `${this.#ctx.connectionId}:${input.cameraId}:${Date.now()}`,
      cameraId: input.cameraId,
      protocol: 'hls',
      playbackUrl,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: 'auto',
      iceServers: [],
      supportedQualities: ['auto'],
    };
  }

  async revokeStreamSession(): Promise<void> {
    // The session is a URL; the camera holds no handle to release.
  }

  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'ONVIF PTZ is a separate profile that this connection does not drive.',
    );
  }

  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'ONVIF events are a separate profile.');
  }

  async getEvent(_eventId: string): Promise<CameraEvent> {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'ONVIF events are a separate profile.');
  }

  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'ONVIF recording playback is a separate profile with uneven support.',
    );
  }

  async getRecording(_recordingId: string): Promise<Recording> {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      'ONVIF recording playback is a separate profile with uneven support.',
    );
  }

  async getStorageStatus(): Promise<StorageStatus> {
    return UNKNOWN_STORAGE;
  }
}
