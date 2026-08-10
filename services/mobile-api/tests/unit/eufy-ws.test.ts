import { describe, expect, it } from 'vitest';
import {
  EufyWsSession,
  EufyWsError,
  type EufyWsDevice,
  type MinimalWebSocket,
} from '../../src/lib/eufy-ws.ts';

/**
 * A scripted stand-in for the bridge socket. It emits `open` then a `version`
 * message on the next tick (after the session has attached its listeners), and
 * auto-replies to each command by messageId with a canned result.
 */
class FakeEufyWs implements MinimalWebSocket {
  static devices: EufyWsDevice[] = [];
  static properties: Record<string, Record<string, unknown>> = {};
  static maxSchemaVersion = 13;
  static sent: Array<Record<string, unknown>> = [];
  static failCommand: string | null = null;

  #listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};

  constructor(public url: string) {
    setTimeout(() => {
      this.#emit('open', {});
      this.#emit('message', {
        data: JSON.stringify({
          type: 'version',
          minSchemaVersion: 0,
          maxSchemaVersion: FakeEufyWs.maxSchemaVersion,
        }),
      });
    }, 0);
  }

  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
    (this.#listeners[type] ??= []).push(cb);
  }

  #emit(type: string, ev: { data?: unknown }): void {
    for (const cb of this.#listeners[type] ?? []) cb(ev);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as { command: string; messageId: string; serialNumber?: string };
    FakeEufyWs.sent.push(msg);
    setTimeout(() => {
      if (FakeEufyWs.failCommand === msg.command) {
        this.#reply({
          type: 'result',
          messageId: msg.messageId,
          success: false,
          errorCode: 'nope',
        });
        return;
      }
      let result: unknown = {};
      if (msg.command === 'start_listening') {
        result = { state: { devices: FakeEufyWs.devices, stations: [] } };
      } else if (msg.command === 'device.get_properties') {
        result = { properties: FakeEufyWs.properties[msg.serialNumber ?? ''] ?? {} };
      }
      this.#reply({ type: 'result', messageId: msg.messageId, success: true, result });
    }, 0);
  }

  #reply(payload: unknown): void {
    this.#emit('message', { data: JSON.stringify(payload) });
  }

  close(): void {
    this.#emit('close', {});
  }
}

function reset(): void {
  FakeEufyWs.devices = [];
  FakeEufyWs.properties = {};
  FakeEufyWs.maxSchemaVersion = 13;
  FakeEufyWs.sent = [];
  FakeEufyWs.failCommand = null;
}

describe('EufyWsSession', () => {
  it('handshakes (pins schema ≤12) and lists devices', async () => {
    reset();
    FakeEufyWs.devices = [
      {
        serialNumber: 'T8210ABC',
        name: 'Front Door',
        model: 'T8210',
        type: 5,
        pictureUrl: 'https://x/y.jpg',
      },
    ];
    const devices = await EufyWsSession.run('ws://eufy.invalid:3000', 1000, FakeEufyWs, (s) =>
      s.listDevices(),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]!.serialNumber).toBe('T8210ABC');

    const schema = FakeEufyWs.sent.find((m) => m.command === 'set_api_schema');
    expect(schema?.schemaVersion).toBe(12); // min(12, maxSchemaVersion=13)
    expect(FakeEufyWs.sent.some((m) => m.command === 'start_listening')).toBe(true);
  });

  it('reads device properties by serial number', async () => {
    reset();
    FakeEufyWs.properties = { T8210ABC: { rtspStreamUrl: 'rtsp://eufy.invalid/live0' } };
    const props = await EufyWsSession.run('ws://eufy.invalid:3000', 1000, FakeEufyWs, (s) =>
      s.getProperties('T8210ABC'),
    );
    expect(props.rtspStreamUrl).toBe('rtsp://eufy.invalid/live0');
  });

  it('sends device.start_rtsp_livestream with the serial number', async () => {
    reset();
    await EufyWsSession.run('ws://eufy.invalid:3000', 1000, FakeEufyWs, (s) =>
      s.startRtsp('T8210ABC'),
    );
    const cmd = FakeEufyWs.sent.find((m) => m.command === 'device.start_rtsp_livestream');
    expect(cmd?.serialNumber).toBe('T8210ABC');
  });

  it('rejects with EufyWsError when the bridge returns an error result', async () => {
    reset();
    FakeEufyWs.failCommand = 'start_listening';
    await expect(
      EufyWsSession.run('ws://eufy.invalid:3000', 1000, FakeEufyWs, (s) => s.listDevices()),
    ).rejects.toBeInstanceOf(EufyWsError);
  });
});
