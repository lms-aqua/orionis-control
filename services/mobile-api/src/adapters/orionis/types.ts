/**
 * Normalised Orionis Guard domain model.
 *
 * This is the contract the iOS app codes against. Vendor- and version-specific
 * shapes are the adapter's problem, never the app's.
 */

export type CameraStatus = 'online' | 'offline' | 'degraded' | 'unknown';
export type StreamProtocol = 'webrtc' | 'llhls' | 'hls' | 'mjpeg';
export type StreamQuality = 'auto' | 'low' | 'medium' | 'high';

/** Capabilities are advertised per camera; the app renders only what is true. */
export interface CameraCapabilities {
  ptz: boolean;
  presets: boolean;
  zoom: boolean;
  light: boolean;
  siren: boolean;
  privacyMode: boolean;
  twoWayAudio: boolean;
  audio: boolean;
  recordingToggle: boolean;
  motionToggle: boolean;
  sensitivity: boolean;
  restart: boolean;
  snapshot: boolean;
  protocols: StreamProtocol[];
  qualities: StreamQuality[];
}

export interface CameraHealth {
  status: CameraStatus;
  recording: boolean;
  streaming: boolean;
  motionDetected: boolean;
  privacyEnabled: boolean;
  lastSeenAt: string | null;
  signalQuality: number | null; // 0..1
  bitrateKbps: number | null;
  frameRate: number | null;
  resolution: string | null;
  message: string | null;
}

export interface Camera {
  id: string;
  name: string;
  location: string | null;
  group: string | null;
  model: string | null;
  firmware: string | null;
  capabilities: CameraCapabilities;
  health: CameraHealth;
  snapshotPath: string | null;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface StreamSession {
  id: string;
  cameraId: string;
  protocol: StreamProtocol;
  playbackUrl: string;
  expiresAt: string;
  quality: StreamQuality;
  iceServers: IceServer[];
  supportedQualities: StreamQuality[];
}

export type CameraEventType =
  | 'motion'
  | 'person'
  | 'vehicle'
  | 'package'
  | 'animal'
  | 'audio'
  | 'offline'
  | 'online'
  | 'recording_failure'
  | 'tamper'
  | 'system';

export type EventSeverity = 'info' | 'warning' | 'critical';

export interface CameraEvent {
  id: string;
  cameraId: string;
  cameraName: string | null;
  type: CameraEventType;
  severity: EventSeverity;
  occurredAt: string;
  endedAt: string | null;
  confidence: number | null;
  thumbnailPath: string | null;
  clipPath: string | null;
  recordingId: string | null;
  retentionUntil: string | null;
  /** Owned by the gateway, merged in by the route layer. */
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  note: string | null;
}

export interface Recording {
  id: string;
  cameraId: string;
  cameraName: string | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  sizeBytes: number | null;
  hasAudio: boolean;
  retentionUntil: string | null;
  playbackPath: string | null;
  markers: { at: string; type: CameraEventType; eventId: string }[];
}

export interface CameraStorageUsage {
  cameraId: string;
  cameraName: string | null;
  bytes: number;
  fileCount: number;
  oldestAt: string | null;
  newestAt: string | null;
}

export interface StorageStatus {
  /** The filesystem holding recordings. Null when it cannot be inspected. */
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  /** Consumed by recordings specifically, as opposed to the whole filesystem. */
  recordingsBytes: number | null;
  /**
   * Budget recordings are allowed to occupy, independent of the disk's size.
   *
   * The filesystem is shared with everything else on the host, so its free space
   * is not the number a viewer cares about — "14 GB of 3 TB used" is, and it is
   * the figure that stays meaningful when something else fills the disk.
   * Null means no budget is set.
   */
  quotaBytes: number | null;
  /** Recordings usage as a fraction of the budget, or null without one. */
  quotaUsedRatio: number | null;
  /** Budget still available. Never negative, and never more than the disk has. */
  quotaFreeBytes: number | null;
  fileCount: number | null;
  /** Average bytes written per day, or null with too little history to divide by. */
  dailyBytes: number | null;
  /** Days of footage the free space can still absorb at the current rate. */
  daysRemaining: number | null;
  retentionDays: number | null;
  oldestRecordingAt: string | null;
  newestRecordingAt: string | null;
  perCamera: CameraStorageUsage[];
}

export interface OrionisServiceHealth {
  id: string;
  name: string;
  status: 'healthy' | 'warning' | 'critical' | 'offline' | 'unknown';
  version: string | null;
  uptimeSeconds: number | null;
  message: string | null;
  checkedAt: string;
}

export type PtzDirection = 'up' | 'down' | 'left' | 'right' | 'stop';

export interface CameraControlRequest {
  action:
    | 'ptz'
    | 'preset'
    | 'zoom'
    | 'light'
    | 'siren'
    | 'privacy'
    | 'recording'
    | 'motion'
    | 'sensitivity'
    | 'restart';
  direction?: PtzDirection;
  presetId?: string;
  value?: boolean | number;
  speed?: number;
}

export interface CameraControlResult {
  applied: boolean;
  state: Record<string, unknown> | null;
  message: string | null;
}

export interface EventQuery {
  cameraIds?: string[];
  types?: CameraEventType[];
  severities?: EventSeverity[];
  from?: string;
  to?: string;
  acknowledged?: boolean;
  limit: number;
  offset: number;
}

export interface RecordingQuery {
  cameraIds?: string[];
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export interface Page<T> {
  items: T[];
  total: number | null;
}

/**
 * The adapter contract.
 *
 * Implementations MUST throw AppError('CAPABILITY_UNSUPPORTED') for operations
 * the upstream genuinely cannot perform, and AppError('SERVICE_NOT_CONFIGURED')
 * when the upstream is absent. They must never synthesise plausible-looking
 * production data.
 */
export interface OrionisAdapter {
  readonly kind: 'http' | 'unconfigured';
  readonly configured: boolean;
  /**
   * Whether anything upstream can actually detect events.
   *
   * Distinct from `configured`: the events endpoint can be perfectly healthy and
   * still be incapable of ever returning anything, because no camera or plugin
   * performs detection. Without this the app shows "no events", which reads as a
   * quiet day rather than a feature that cannot work.
   */
  readonly eventDetection: boolean;

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
  acknowledgeEventUpstream(eventId: string, note: string | null): Promise<boolean>;
  listRecordings(query: RecordingQuery): Promise<Page<Recording>>;
  getRecording(recordingId: string): Promise<Recording>;
  getStorageStatus(): Promise<StorageStatus>;
  listServiceHealth(): Promise<OrionisServiceHealth[]>;
  runServiceAction(serviceId: string, action: string): Promise<{ ok: boolean; message: string }>;
}

/**
 * Storage when nothing can be measured. Capacity stays null rather than 0: a
 * reported 0 free would read as "disk full" instead of "unknown".
 */
export const UNKNOWN_STORAGE: StorageStatus = {
  totalBytes: null,
  usedBytes: null,
  freeBytes: null,
  recordingsBytes: null,
  quotaBytes: null,
  quotaUsedRatio: null,
  quotaFreeBytes: null,
  fileCount: null,
  dailyBytes: null,
  daysRemaining: null,
  retentionDays: null,
  oldestRecordingAt: null,
  newestRecordingAt: null,
  perCamera: [],
};
