import { describe, expect, it } from 'vitest';
import { Go2rtcOrionisAdapter } from '../../src/adapters/orionis/go2rtc.ts';
import { MediaMtxRecordings } from '../../src/adapters/orionis/mediamtx-recordings.ts';

function streams(body: object): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('Go2rtcOrionisAdapter camera identity', () => {
  it('does not treat Object prototype names as cameras', async () => {
    const adapter = new Go2rtcOrionisAdapter(
      'http://go2rtc.invalid',
      1_000,
      streams({ front: { producers: [{ url: 'rtsp://camera.invalid' }] } }),
    );

    await expect(adapter.getCamera('toString')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(adapter.getSnapshot('constructor')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps configured transcode twins out of the user-visible wall', async () => {
    const adapter = new Go2rtcOrionisAdapter(
      'http://go2rtc.invalid',
      1_000,
      streams({
        front: { producers: [{ url: 'rtsp://camera.invalid' }] },
        front_ll: { producers: [{ url: 'ffmpeg:front' }] },
        front_hq: { producers: [{ url: 'ffmpeg:front' }] },
        front_aac: { producers: [{ url: 'ffmpeg:front' }] },
      }),
    );

    expect((await adapter.listCameras()).map((camera) => camera.id)).toEqual(['front']);
  });

  it('preserves WebRTC quality so signalling can select the matching rendition', async () => {
    const adapter = new Go2rtcOrionisAdapter(
      'http://go2rtc.invalid',
      1_000,
      streams({}),
      {},
      null,
      true,
    );

    const session = await adapter.createStreamSession({
      cameraId: 'front',
      preferredProtocols: ['webrtc'],
      quality: 'high',
      ttlSeconds: 60,
    });
    expect(session.quality).toBe('high');
    expect(session.supportedQualities).toEqual(['auto', 'low', 'medium', 'high']);
  });

  it('reports audio only when active producer metadata proves an audio track', async () => {
    const adapter = new Go2rtcOrionisAdapter(
      'http://go2rtc.invalid',
      1_000,
      streams({
        audio: {
          producers: [
            {
              url: 'rtsp://audio.invalid',
              medias: ['video, recvonly, H264', 'audio, recvonly, PCMA'],
            },
          ],
        },
        video: {
          producers: [{ url: 'rtsp://video.invalid', medias: ['video, recvonly, H264'] }],
        },
        unknown: { producers: [{ url: 'rtsp://unknown.invalid' }] },
      }),
    );
    const cameras = Object.fromEntries(
      (await adapter.listCameras()).map((camera) => [camera.id, camera]),
    );
    expect(cameras.audio!.capabilities.audio).toBe(true);
    expect(cameras.video!.capabilities.audio).toBe(false);
    expect(cameras.unknown!.capabilities.audio).toBeNull();
  });

  it('keeps historical footage visible while a labelled camera is offline', async () => {
    const recordings = new MediaMtxRecordings(
      'http://recordings.invalid',
      1_000,
      7,
      (async () =>
        new Response(
          JSON.stringify([{ start: '2026-08-01T12:00:00.000Z', duration: 60 }]),
        )) as typeof fetch,
    );
    const adapter = new Go2rtcOrionisAdapter(
      'http://go2rtc.invalid',
      1_000,
      streams({}),
      { offline: { name: 'Offline Camera', location: null } },
      recordings,
    );

    const page = await adapter.listRecordings({ cameraIds: ['offline'], limit: 10, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items[0]!.cameraName).toBe('Offline Camera');
  });
});
