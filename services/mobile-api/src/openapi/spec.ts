/**
 * OpenAPI document, generated from the same constants the routes use.
 *
 * This is the machine-readable half of the API contract; the iOS models are
 * checked against it by the contract test in tests/contract.
 */
import { API_VERSION, SERVER_VERSION } from '../version.ts';
import { API_PREFIX } from '../app.ts';
import { PERMISSIONS, ROLES } from '../auth/roles.ts';
import { SYSTEM_ACTIONS } from '../routes/system.ts';
import { NOTIFICATION_KINDS } from '../notifications/push.ts';

const envelope = (dataSchema: object): object => ({
  type: 'object',
  required: ['success', 'data', 'requestId', 'serverTime'],
  properties: {
    success: { type: 'boolean', enum: [true] },
    data: dataSchema,
    requestId: { type: 'string' },
    serverTime: { type: 'string', format: 'date-time' },
  },
});

const ref = (name: string): object => ({ $ref: `#/components/schemas/${name}` });

const jsonResponse = (description: string, schema: object): object => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponse = (description: string): object =>
  jsonResponse(description, ref('ErrorEnvelope'));

const commonErrors = {
  '400': errorResponse('Validation failed'),
  '401': errorResponse('Not authenticated, token expired, or session revoked'),
  '403': errorResponse('Insufficient role'),
  '429': errorResponse('Rate limited'),
  '500': errorResponse('Unexpected gateway error'),
  '503': errorResponse('Upstream service unavailable or not configured'),
};

const authed = [{ bearerAuth: [] }];

function get(summary: string, tag: string, dataSchema: object, extra: object = {}): object {
  return {
    get: {
      tags: [tag],
      summary,
      security: authed,
      responses: { '200': jsonResponse('Success', envelope(dataSchema)), ...commonErrors },
      ...extra,
    },
  };
}

export function buildOpenApiDocument(): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Orionis Control — Mobile API',
      version: API_VERSION,
      description:
        'Backend-for-frontend used exclusively by the Orionis Control iOS app. ' +
        'All upstream credentials remain server-side; the app receives only ' +
        'short-lived, revocable gateway sessions.',
      contact: { name: 'Orionis Control' },
    },
    servers: [
      {
        url: `{origin}${API_PREFIX}`,
        variables: { origin: { default: 'https://gateway.example.invalid' } },
      },
    ],
    tags: [
      { name: 'meta', description: 'Discovery and liveness' },
      { name: 'auth', description: 'OIDC sign-in, tokens and sessions' },
      { name: 'cameras', description: 'Cameras, snapshots, streams and controls' },
      { name: 'events', description: 'Camera events and recordings' },
      { name: 'adguard', description: 'AdGuard Home status and management' },
      { name: 'system', description: 'Service health, dashboard and approved actions' },
      { name: 'devices', description: 'Device sessions, push and preferences' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        ErrorEnvelope: {
          type: 'object',
          required: ['success', 'error', 'requestId', 'serverTime'],
          properties: {
            success: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              required: ['code', 'message', 'recoverable'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                recoverable: { type: 'boolean' },
                details: { nullable: true },
              },
            },
            requestId: { type: 'string' },
            serverTime: { type: 'string', format: 'date-time' },
          },
        },
        Role: { type: 'string', enum: [...ROLES] },
        Permission: { type: 'string', enum: [...PERMISSIONS] },
        NotificationKind: { type: 'string', enum: [...NOTIFICATION_KINDS] },
        SystemActionId: { type: 'string', enum: SYSTEM_ACTIONS.map((a) => a.id) },
        CameraStatus: { type: 'string', enum: ['online', 'offline', 'degraded', 'unknown'] },
        StreamProtocol: { type: 'string', enum: ['webrtc', 'llhls', 'hls', 'mjpeg'] },
        StreamQuality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
        ServiceStatus: {
          type: 'string',
          enum: ['healthy', 'warning', 'critical', 'offline', 'unknown'],
        },
        EventType: {
          type: 'string',
          enum: [
            'motion',
            'person',
            'vehicle',
            'package',
            'animal',
            'audio',
            'offline',
            'online',
            'recording_failure',
            'tamper',
            'system',
          ],
        },
        EventSeverity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        QueryStatus: {
          type: 'string',
          enum: ['allowed', 'blocked', 'rewritten', 'safe_search', 'unknown'],
        },
        Camera: {
          type: 'object',
          required: ['id', 'name', 'capabilities', 'health'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            location: { type: 'string', nullable: true },
            group: { type: 'string', nullable: true },
            model: { type: 'string', nullable: true },
            firmware: { type: 'string', nullable: true },
            snapshotPath: { type: 'string', nullable: true },
            capabilities: {
              type: 'object',
              properties: {
                ptz: { type: 'boolean' },
                presets: { type: 'boolean' },
                zoom: { type: 'boolean' },
                light: { type: 'boolean' },
                siren: { type: 'boolean' },
                privacyMode: { type: 'boolean' },
                twoWayAudio: { type: 'boolean' },
                audio: { type: 'boolean', nullable: true },
                recordingToggle: { type: 'boolean' },
                motionToggle: { type: 'boolean' },
                sensitivity: { type: 'boolean' },
                restart: { type: 'boolean' },
                snapshot: { type: 'boolean' },
                protocols: { type: 'array', items: ref('StreamProtocol') },
                qualities: { type: 'array', items: ref('StreamQuality') },
              },
            },
            health: {
              type: 'object',
              properties: {
                status: ref('CameraStatus'),
                recording: { type: 'boolean', nullable: true },
                streaming: { type: 'boolean' },
                motionDetected: { type: 'boolean' },
                privacyEnabled: { type: 'boolean' },
                lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
                signalQuality: { type: 'number', nullable: true },
                bitrateKbps: { type: 'number', nullable: true },
                frameRate: { type: 'number', nullable: true },
                resolution: { type: 'string', nullable: true },
                message: { type: 'string', nullable: true },
              },
            },
          },
        },
        CameraEvent: {
          type: 'object',
          required: ['id', 'cameraId', 'type', 'severity', 'occurredAt', 'acknowledged'],
          properties: {
            id: { type: 'string' },
            cameraId: { type: 'string' },
            cameraName: { type: 'string', nullable: true },
            type: ref('EventType'),
            severity: ref('EventSeverity'),
            occurredAt: { type: 'string', format: 'date-time' },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            confidence: { type: 'number', nullable: true },
            thumbnailPath: { type: 'string', nullable: true },
            clipPath: { type: 'string', nullable: true },
            recordingId: { type: 'string', nullable: true },
            retentionUntil: { type: 'string', format: 'date-time', nullable: true },
            acknowledged: { type: 'boolean' },
            acknowledgedBy: { type: 'string', nullable: true },
            acknowledgedAt: { type: 'string', format: 'date-time', nullable: true },
            note: { type: 'string', nullable: true },
          },
        },
        AdGuardStatus: {
          type: 'object',
          required: ['protectionEnabled', 'running', 'checkedAt'],
          properties: {
            protectionEnabled: { type: 'boolean' },
            running: { type: 'boolean' },
            version: { type: 'string', nullable: true },
            dnsPort: { type: 'integer', nullable: true },
            protectionDisabledUntil: { type: 'string', format: 'date-time', nullable: true },
            filteringEnabled: { type: 'boolean' },
            safeBrowsingEnabled: { type: 'boolean', nullable: true },
            parentalEnabled: { type: 'boolean', nullable: true },
            checkedAt: { type: 'string', format: 'date-time' },
            override: { type: 'object', nullable: true },
          },
        },
        DnsQuery: {
          type: 'object',
          required: ['id', 'at', 'client', 'domain', 'status'],
          properties: {
            id: { type: 'string' },
            at: { type: 'string', format: 'date-time' },
            client: { type: 'string' },
            clientName: { type: 'string', nullable: true },
            domain: { type: 'string' },
            type: { type: 'string' },
            upstream: { type: 'string', nullable: true },
            processingMs: { type: 'number', nullable: true },
            status: ref('QueryStatus'),
            rule: { type: 'string', nullable: true },
            ruleFilterId: { type: 'integer', nullable: true },
            responseCode: { type: 'string', nullable: true },
            reason: { type: 'string', nullable: true },
            answers: { type: 'array', items: { type: 'string' } },
          },
        },
        ServiceHealth: {
          type: 'object',
          required: ['id', 'name', 'status', 'checkedAt'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            status: ref('ServiceStatus'),
            message: { type: 'string', nullable: true },
            latencyMs: { type: 'number', nullable: true },
            version: { type: 'string', nullable: true },
            checkedAt: { type: 'string', format: 'date-time' },
            impacts: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    paths: {
      '/meta': {
        get: {
          tags: ['meta'],
          summary: 'Gateway capabilities and API version (unauthenticated)',
          responses: { '200': jsonResponse('Success', envelope({ type: 'object' })) },
        },
      },
      '/health': {
        get: {
          tags: ['meta'],
          summary: 'Gateway liveness (unauthenticated)',
          responses: { '200': jsonResponse('Success', envelope({ type: 'object' })) },
        },
      },
      '/auth/login': {
        get: {
          tags: ['auth'],
          summary: 'Begin OIDC sign-in; redirects to Authelia',
          parameters: [
            { name: 'code_challenge', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'device_id', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '302': { description: 'Redirect to the identity provider' },
            '400': errorResponse('Invalid request or disallowed redirect scheme'),
            '503': errorResponse('OIDC not configured'),
          },
        },
      },
      '/auth/callback': {
        get: {
          tags: ['auth'],
          summary: 'Identity provider callback; redirects back to the app scheme',
          responses: { '302': { description: 'Redirect to the app' } },
        },
      },
      '/auth/token': {
        post: {
          tags: ['auth'],
          summary: 'Exchange the one-time app code for gateway tokens (PKCE verified)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['code', 'code_verifier'],
                  properties: {
                    code: { type: 'string' },
                    code_verifier: { type: 'string', minLength: 43, maxLength: 128 },
                    device: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: {
            '200': jsonResponse('Tokens issued', envelope({ type: 'object' })),
            ...commonErrors,
          },
        },
      },
      '/auth/refresh': {
        post: {
          tags: ['auth'],
          summary: 'Rotate the refresh token (reuse revokes the family)',
          responses: {
            '200': jsonResponse('Rotated', envelope({ type: 'object' })),
            ...commonErrors,
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'Revoke this session',
          security: authed,
          responses: {
            '200': jsonResponse('Revoked', envelope({ type: 'object' })),
            ...commonErrors,
          },
        },
      },
      '/me': get('Current user, role and permissions', 'auth', { type: 'object' }),
      '/dashboard': get('Aggregated home dashboard', 'system', { type: 'object' }),
      '/cameras': get('All authorised cameras', 'cameras', {
        type: 'object',
        properties: { items: { type: 'array', items: ref('Camera') }, total: { type: 'integer' } },
      }),
      '/cameras/{cameraId}': get('One camera', 'cameras', ref('Camera'), {
        parameters: [{ name: 'cameraId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
      '/cameras/{cameraId}/snapshot': {
        get: {
          tags: ['cameras'],
          summary: 'Current snapshot (image/jpeg)',
          security: authed,
          parameters: [
            { name: 'cameraId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'JPEG image', content: { 'image/jpeg': {} } },
            ...commonErrors,
          },
        },
      },
      '/cameras/{cameraId}/stream-sessions': {
        post: {
          tags: ['cameras'],
          summary: 'Create a short-lived, user-bound stream session',
          security: authed,
          parameters: [
            { name: 'cameraId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': jsonResponse('Created', envelope({ type: 'object' })),
            ...commonErrors,
          },
        },
      },
      '/cameras/{cameraId}/controls': {
        post: {
          tags: ['cameras'],
          summary: 'Invoke a supported camera control',
          security: authed,
          parameters: [
            { name: 'cameraId', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'X-Confirm-Disruptive',
              in: 'header',
              required: false,
              schema: { type: 'string', enum: ['true'] },
              description: 'Required for siren, privacy, recording and restart.',
            },
          ],
          responses: {
            '200': jsonResponse('Applied', envelope({ type: 'object' })),
            '501': errorResponse('The camera does not support this control'),
            ...commonErrors,
          },
        },
      },
      '/events': get('Camera events', 'events', {
        type: 'object',
        properties: {
          items: { type: 'array', items: ref('CameraEvent') },
          page: { type: 'object' },
        },
      }),
      '/events/{eventId}': get('One event', 'events', ref('CameraEvent'), {
        parameters: [{ name: 'eventId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
      '/events/{eventId}/acknowledge': {
        post: {
          tags: ['events'],
          summary: 'Acknowledge an event, optionally with a note',
          security: authed,
          parameters: [{ name: 'eventId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': jsonResponse('Acknowledged', envelope(ref('CameraEvent'))),
            ...commonErrors,
          },
        },
      },
      '/recordings': get('Recordings', 'events', { type: 'object' }),
      '/recordings/{recordingId}': get(
        'One recording',
        'events',
        { type: 'object' },
        {
          parameters: [
            { name: 'recordingId', in: 'path', required: true, schema: { type: 'string' } },
          ],
        },
      ),
      '/adguard/status': get('Protection state and attribution', 'adguard', ref('AdGuardStatus')),
      '/adguard/stats': get('Statistics for a time range', 'adguard', { type: 'object' }),
      '/adguard/query-log': get('Searchable DNS query log', 'adguard', {
        type: 'object',
        properties: { items: { type: 'array', items: ref('DnsQuery') }, page: { type: 'object' } },
      }),
      '/adguard/clients': get('Known DNS clients', 'adguard', { type: 'object' }),
      '/adguard/filters': get('Installed filter lists', 'adguard', { type: 'object' }),
      '/adguard/rules': {
        ...get('Custom filtering rules', 'adguard', { type: 'object' }),
        post: {
          tags: ['adguard'],
          summary: 'Add a validated allow or block rule',
          security: authed,
          responses: {
            '200': jsonResponse('Added', envelope({ type: 'object' })),
            '409': errorResponse('The rule already exists'),
            '422': errorResponse('The rule syntax is invalid'),
            ...commonErrors,
          },
        },
        delete: {
          tags: ['adguard'],
          summary: 'Remove a custom rule',
          security: authed,
          responses: {
            '200': jsonResponse('Removed', envelope({ type: 'object' })),
            ...commonErrors,
          },
        },
      },
      '/adguard/protection': {
        post: {
          tags: ['adguard'],
          summary: 'Enable protection, or pause it for a bounded duration',
          description:
            'Pausing requires a duration or resume time; indefinite pauses are rejected. ' +
            'Requires the X-Confirm-Disruptive header and is always audited.',
          security: authed,
          responses: {
            '200': jsonResponse('Applied', envelope(ref('AdGuardStatus'))),
            ...commonErrors,
          },
        },
      },
      '/system/services': get('Aggregated service health', 'system', {
        type: 'object',
        properties: {
          overall: ref('ServiceStatus'),
          services: { type: 'array', items: ref('ServiceHealth') },
        },
      }),
      '/system/services/{serviceId}': get('One service', 'system', ref('ServiceHealth'), {
        parameters: [{ name: 'serviceId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
      '/system/actions': {
        ...get('The allow-list of runnable operations', 'system', { type: 'object' }),
        post: {
          tags: ['system'],
          summary: 'Run an approved operation',
          security: authed,
          responses: { '200': jsonResponse('Ran', envelope({ type: 'object' })), ...commonErrors },
        },
      },
      '/devices': get('Registered device sessions', 'devices', { type: 'object' }),
      '/devices/current': get('This device session', 'devices', { type: 'object' }),
      '/notifications/preferences': {
        ...get('Notification preferences', 'devices', { type: 'object' }),
        put: {
          tags: ['devices'],
          summary: 'Replace notification preferences',
          security: authed,
          responses: {
            '200': jsonResponse('Saved', envelope({ type: 'object' })),
            ...commonErrors,
          },
        },
      },
      '/audit': get('Audit log (administrator only)', 'system', { type: 'object' }),
      '/diagnostics/incidents': {
        post: {
          tags: ['system'],
          summary: 'Submit a bounded, redacted client media incident',
          security: authed,
          responses: {
            '200': jsonResponse('Accepted', envelope({ type: 'object' })),
            ...commonErrors,
          },
        },
      },
    },
    'x-server-version': SERVER_VERSION,
  };
}
