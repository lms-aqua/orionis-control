/**
 * Test doubles for the upstream adapters.
 *
 * These live ONLY in the test target. Production code cannot import them:
 * services.ts constructs either the HTTP adapter or the explicit
 * "unconfigured" adapter, never a stub.
 */
import { AppError } from '../../src/lib/errors.ts';
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
  StreamSession,
} from '../../src/adapters/orionis/types.ts';
import { UNKNOWN_STORAGE } from '../../src/adapters/orionis/types.ts';
import type {
  AdGuardAdapter,
  AdGuardStats,
  AdGuardStatus,
  CustomRules,
  DnsClient,
  DnsQuery,
  FilterList,
  ProtectionChange,
  TimeRange,
} from '../../src/adapters/adguard/types.ts';

export function makeCamera(overrides: Partial<Camera> = {}): Camera {
  return {
    id: 'cam-front',
    name: 'Front Door',
    location: 'Entry',
    group: 'Perimeter',
    model: 'TestCam 100',
    firmware: '1.0.0',
    snapshotPath: '/snapshot',
    capabilities: {
      ptz: true,
      presets: false,
      zoom: false,
      light: true,
      siren: false,
      privacyMode: true,
      twoWayAudio: false,
      audio: true,
      recordingToggle: true,
      motionToggle: true,
      sensitivity: false,
      restart: true,
      snapshot: true,
      protocols: ['webrtc', 'hls'],
      qualities: ['auto', 'low', 'high'],
    },
    health: {
      status: 'online',
      recording: true,
      streaming: false,
      motionDetected: false,
      privacyEnabled: false,
      lastSeenAt: '2026-07-31T12:00:00.000Z',
      signalQuality: 0.92,
      bitrateKbps: 2400,
      frameRate: 20,
      resolution: '1920x1080',
      message: null,
    },
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<CameraEvent> = {}): CameraEvent {
  return {
    id: 'evt-1',
    cameraId: 'cam-front',
    cameraName: 'Front Door',
    type: 'person',
    severity: 'warning',
    occurredAt: '2026-07-31T12:00:00.000Z',
    endedAt: null,
    confidence: 0.88,
    thumbnailPath: '/thumb/evt-1',
    clipPath: null,
    recordingId: 'rec-1',
    retentionUntil: '2026-08-14T12:00:00.000Z',
    acknowledged: false,
    acknowledgedBy: null,
    acknowledgedAt: null,
    note: null,
    ...overrides,
  };
}

export class StubOrionisAdapter implements OrionisAdapter {
  readonly kind = 'http' as const;
  readonly configured = true;
  readonly eventDetection = true;

  cameras: Camera[] = [
    makeCamera(),
    makeCamera({
      id: 'cam-yard',
      name: 'Back Yard',
      location: 'Garden',
      health: { ...makeCamera().health, status: 'offline', recording: false },
    }),
  ];
  events: CameraEvent[] = [
    makeEvent(),
    makeEvent({ id: 'evt-2', type: 'motion', severity: 'info' }),
  ];
  recordings: Recording[] = [];
  controlCalls: { cameraId: string; req: CameraControlRequest }[] = [];
  streamRevocations: string[] = [];
  acknowledgeUpstreamResult = true;
  failWith: AppError | null = null;

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  async listCameras(): Promise<Camera[]> {
    this.guard();
    return this.cameras;
  }
  async getCamera(cameraId: string): Promise<Camera> {
    this.guard();
    const found = this.cameras.find((c) => c.id === cameraId);
    if (!found) throw AppError.notFound('That camera');
    return found;
  }
  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    this.guard();
    return {
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      contentType: 'image/jpeg',
      capturedAt: new Date().toISOString(),
    };
  }
  async createStreamSession(input: {
    cameraId: string;
    preferredProtocols: string[];
    quality: string;
    ttlSeconds: number;
  }): Promise<StreamSession> {
    this.guard();
    return {
      id: 'upstream-stream-1',
      cameraId: input.cameraId,
      protocol: input.preferredProtocols[0] as StreamSession['protocol'],
      playbackUrl: 'https://media.internal.invalid/live/cam-front',
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      quality: input.quality as StreamSession['quality'],
      iceServers: [{ urls: ['stun:stun.example.invalid:3478'] }],
      supportedQualities: ['auto', 'low', 'high'],
    };
  }
  async revokeStreamSession(id: string): Promise<void> {
    this.streamRevocations.push(id);
  }
  async invokeControl(cameraId: string, req: CameraControlRequest): Promise<CameraControlResult> {
    this.guard();
    this.controlCalls.push({ cameraId, req });
    return { applied: true, state: { [req.action]: req.value ?? true }, message: null };
  }
  async listEvents(query: EventQuery): Promise<Page<CameraEvent>> {
    this.guard();
    let items = this.events;
    if (query.cameraIds?.length) items = items.filter((e) => query.cameraIds!.includes(e.cameraId));
    if (query.types?.length) items = items.filter((e) => query.types!.includes(e.type));
    return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
  }
  async getEvent(eventId: string): Promise<CameraEvent> {
    this.guard();
    const found = this.events.find((e) => e.id === eventId);
    if (!found) throw AppError.notFound('That event');
    return found;
  }
  async acknowledgeEventUpstream(): Promise<boolean> {
    return this.acknowledgeUpstreamResult;
  }
  async listRecordings(query: RecordingQuery): Promise<Page<Recording>> {
    this.guard();
    return {
      items: this.recordings.slice(query.offset, query.offset + query.limit),
      total: this.recordings.length,
    };
  }
  async getRecording(id: string): Promise<Recording> {
    this.guard();
    const found = this.recordings.find((r) => r.id === id);
    if (!found) throw AppError.notFound('That recording');
    return found;
  }
  async getStorageStatus(): Promise<StorageStatus> {
    this.guard();
    return {
      ...UNKNOWN_STORAGE,
      totalBytes: 4_000_000_000_000,
      usedBytes: 2_800_000_000_000,
      freeBytes: 1_200_000_000_000,
      recordingsBytes: 900_000_000_000,
      fileCount: 1200,
      dailyBytes: 17_000_000_000,
      daysRemaining: 70,
      retentionDays: 30,
      oldestRecordingAt: '2026-07-01T00:00:00.000Z',
      newestRecordingAt: '2026-08-01T00:00:00.000Z',
      perCamera: [
        {
          cameraId: 'cam-front',
          cameraName: 'Front',
          bytes: 500_000_000_000,
          fileCount: 700,
          oldestAt: '2026-07-01T00:00:00.000Z',
          newestAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    };
  }
  async listServiceHealth(): Promise<OrionisServiceHealth[]> {
    this.guard();
    return [
      {
        id: 'orionis-api',
        name: 'Orionis Guard API',
        status: 'healthy',
        version: '2.1.0',
        uptimeSeconds: 86_400,
        message: null,
        checkedAt: new Date().toISOString(),
      },
    ];
  }
  async runServiceAction(serviceId: string): Promise<{ ok: boolean; message: string }> {
    this.guard();
    return { ok: true, message: `${serviceId} restarted.` };
  }
}

export class StubAdGuardAdapter implements AdGuardAdapter {
  readonly configured = true;
  protectionEnabled = true;
  rules: string[] = ['||ads.example.invalid^'];
  protectionCalls: ProtectionChange[] = [];
  failWith: AppError | null = null;

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  async getStatus(): Promise<AdGuardStatus> {
    this.guard();
    return {
      protectionEnabled: this.protectionEnabled,
      running: true,
      version: 'v0.107.60',
      dnsPort: 53,
      protectionDisabledUntil: null,
      filteringEnabled: true,
      safeBrowsingEnabled: false,
      parentalEnabled: false,
      checkedAt: new Date().toISOString(),
    };
  }
  async getStats(range: TimeRange): Promise<AdGuardStats> {
    this.guard();
    return {
      range,
      totalQueries: 10_000,
      blockedQueries: 2_500,
      blockedPercent: 25,
      replacedSafeBrowsing: 3,
      replacedParental: 0,
      averageProcessingMs: 12.5,
      topClients: [{ name: '10.0.0.5', count: 4000 }],
      topQueriedDomains: [{ name: 'example.invalid', count: 900 }],
      topBlockedDomains: [{ name: 'ads.example.invalid', count: 700 }],
      series: [{ at: '2026-07-31T11:00:00.000Z', queries: 500, blocked: 120 }],
    };
  }
  async getQueryLog(opts: {
    limit: number;
  }): Promise<{ items: DnsQuery[]; oldest: string | null }> {
    this.guard();
    const items: DnsQuery[] = [
      {
        id: 'q1',
        at: '2026-07-31T12:00:00.000Z',
        client: '10.0.0.5',
        clientName: 'laptop',
        domain: 'ads.example.invalid',
        type: 'A',
        upstream: null,
        processingMs: 1.2,
        status: 'blocked',
        rule: '||ads.example.invalid^',
        ruleFilterId: 1,
        responseCode: 'NOERROR',
        answers: [],
      },
    ];
    return { items: items.slice(0, opts.limit), oldest: null };
  }
  async listClients(): Promise<DnsClient[]> {
    this.guard();
    return [
      {
        id: 'laptop',
        name: 'laptop',
        ids: ['10.0.0.5'],
        useGlobalSettings: true,
        filteringEnabled: true,
        safeBrowsingEnabled: false,
        parentalEnabled: false,
        tags: [],
        lastSeenAt: null,
        queryCount: null,
        blockedCount: null,
      },
    ];
  }
  async listFilters(): Promise<FilterList[]> {
    this.guard();
    return [
      {
        id: 1,
        name: 'Test list',
        url: 'https://filters.example.invalid/list.txt',
        enabled: true,
        ruleCount: 1234,
        lastUpdatedAt: '2026-07-30T00:00:00.000Z',
        whitelist: false,
      },
    ];
  }
  async getCustomRules(): Promise<CustomRules> {
    this.guard();
    return { rules: [...this.rules] };
  }
  async setCustomRules(rules: string[]): Promise<void> {
    this.guard();
    this.rules = rules;
  }
  async refreshFilters(): Promise<{ updated: number }> {
    this.guard();
    return { updated: 1 };
  }
  async setProtection(change: ProtectionChange): Promise<AdGuardStatus> {
    this.guard();
    this.protectionCalls.push(change);
    this.protectionEnabled = change.enabled;
    return this.getStatus();
  }
  async probe(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: this.failWith === null, latencyMs: 3 };
  }
}
