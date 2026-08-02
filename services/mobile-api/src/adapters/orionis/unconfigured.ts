/**
 * The adapter used when no Orionis Guard upstream is configured.
 *
 * It exists so the whole product — routes, RBAC, auditing, the app's error
 * states — is exercised end to end without inventing camera data. Every method
 * fails with the same typed, honest error.
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
  StreamSession,
} from './types.ts';

const REASON =
  'Orionis Guard is not connected to this gateway. Set ORIONIS_INTERNAL_URL (and ORIONIS_SERVICE_TOKEN if the upstream requires one) and restart the service.';

function unconfigured(): never {
  throw new AppError('SERVICE_NOT_CONFIGURED', REASON);
}

export class UnconfiguredOrionisAdapter implements OrionisAdapter {
  readonly kind = 'unconfigured' as const;
  readonly configured = false;
  // Nothing is wired up at all.
  readonly eventDetection = false;

  async listCameras(): Promise<Camera[]> {
    unconfigured();
  }
  async getCamera(): Promise<Camera> {
    unconfigured();
  }
  async getSnapshot(): Promise<{ bytes: Buffer; contentType: string; capturedAt: string }> {
    unconfigured();
  }
  async createStreamSession(): Promise<StreamSession> {
    unconfigured();
  }
  async revokeStreamSession(): Promise<void> {
    unconfigured();
  }
  async invokeControl(_cameraId: string, _req: CameraControlRequest): Promise<CameraControlResult> {
    unconfigured();
  }
  async listEvents(_query: EventQuery): Promise<Page<CameraEvent>> {
    unconfigured();
  }
  async getEvent(): Promise<CameraEvent> {
    unconfigured();
  }
  async acknowledgeEventUpstream(): Promise<boolean> {
    // Acknowledgement is owned locally by the gateway, so this is not an error:
    // it simply reports that nothing was propagated upstream.
    return false;
  }
  async listRecordings(_query: RecordingQuery): Promise<Page<Recording>> {
    unconfigured();
  }
  async getRecording(): Promise<Recording> {
    unconfigured();
  }
  async getStorageStatus(): Promise<StorageStatus> {
    unconfigured();
  }
  async listServiceHealth(): Promise<OrionisServiceHealth[]> {
    // Health aggregation must still return a row so the System screen can show
    // an honest "not configured" state rather than an empty list.
    return [
      {
        id: 'orionis-api',
        name: 'Orionis Guard API',
        status: 'unknown',
        version: null,
        uptimeSeconds: null,
        message: REASON,
        checkedAt: new Date().toISOString(),
      },
    ];
  }
  async runServiceAction(): Promise<{ ok: boolean; message: string }> {
    unconfigured();
  }
}
