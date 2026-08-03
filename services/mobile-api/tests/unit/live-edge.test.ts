import { describe, expect, it } from 'vitest';
import { joinAtLiveEdge, webRTCSource } from '../../src/routes/cameras.ts';

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:195',
  '#EXTINF:1.99900,',
  'seg195.ts?session=abc',
  '',
].join('\n');

describe('joinAtLiveEdge', () => {
  it('asks the player to start near the live edge', () => {
    const out = joinAtLiveEdge(PLAYLIST);
    expect(out).toContain('#EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES');
    // Immediately after the header, where the tag belongs.
    expect(out.split('\n')[1]).toContain('#EXT-X-START');
  });

  it('scales the offset with the target duration', () => {
    const out = joinAtLiveEdge(PLAYLIST.replace('TARGETDURATION:2', 'TARGETDURATION:6'));
    expect(out).toContain('TIME-OFFSET=-9.000');
  });

  it('never asks for an offset shorter than a second', () => {
    // A sub-second target duration would otherwise produce an offset so small the
    // player starves on the very next segment.
    const out = joinAtLiveEdge(PLAYLIST.replace('TARGETDURATION:2', 'TARGETDURATION:0'));
    expect(out).toContain('TIME-OFFSET=-3.000');
  });

  it('falls back to a sane offset when the playlist declares no target', () => {
    const out = joinAtLiveEdge('#EXTM3U\n#EXTINF:2.0,\nseg1.ts\n');
    expect(out).toContain('TIME-OFFSET=-3.000');
  });

  it('leaves a playlist that already positions itself alone', () => {
    const already = PLAYLIST.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=-1,PRECISE=NO');
    expect(joinAtLiveEdge(already)).toBe(already);
  });

  it('preserves the rest of the playlist exactly', () => {
    const out = joinAtLiveEdge(PLAYLIST);
    for (const line of PLAYLIST.split('\n')) {
      expect(out).toContain(line);
    }
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:195');
  });
});

describe('webRTCSource', () => {
  it('keeps the native camera source instead of forcing a software transcode', () => {
    expect(webRTCSource('cam-front')).toBe('cam-front');
    expect(webRTCSource('cam-front')).not.toContain('_ll');
  });
});
