/**
 * Upstream address validation.
 *
 * Connection settings are the one place where a stored value decides what the
 * gateway will fetch, so the guard has to hold in both directions: refuse the
 * addresses that turn the server into a request proxy for someone else, and
 * keep allowing the private addresses every real deployment actually uses.
 */
import { describe, expect, it } from 'vitest';
import { assertSafeSettings, assertSafeUpstreamUrl } from '../../src/lib/upstream-url.ts';
import { AppError } from '../../src/lib/errors.ts';

const field = (over: Partial<{ key: string; label: string; type: string; required: boolean }> = {}) => ({
  key: 'baseUrl',
  label: 'Frigate URL',
  type: 'url',
  required: true,
  ...over,
});

describe('assertSafeUpstreamUrl', () => {
  it('accepts the addresses real deployments use', () => {
    // Container names, private ranges and loopback are the normal case here —
    // blanket-denying them would break the feature it is meant to protect.
    for (const url of [
      'http://frigate:5000',
      'https://frigate.internal:8971',
      'http://192.168.1.50:1984',
      'http://10.0.0.4:5000',
      'http://127.0.0.1:1984',
      'http://localhost:1984',
    ]) {
      expect(assertSafeUpstreamUrl(url, 'Frigate URL')).toBe(url);
    }
  });

  it('refuses cloud metadata by address', () => {
    expect(() => assertSafeUpstreamUrl('http://169.254.169.254/latest/meta-data/', 'Frigate URL'))
      .toThrow(AppError);
  });

  it('refuses cloud metadata by hostname', () => {
    expect(() => assertSafeUpstreamUrl('http://metadata.google.internal/', 'Frigate URL')).toThrow(
      AppError,
    );
  });

  it('refuses link-local addresses generally, not just the metadata one', () => {
    expect(() => assertSafeUpstreamUrl('http://169.254.10.9:8080', 'Frigate URL')).toThrow(AppError);
    expect(() => assertSafeUpstreamUrl('http://[fe80::1]:8080', 'Frigate URL')).toThrow(AppError);
  });

  it('refuses schemes that are not HTTP', () => {
    for (const url of ['file:///etc/passwd', 'gopher://host:70/x', 'ftp://host/x']) {
      expect(() => assertSafeUpstreamUrl(url, 'Frigate URL')).toThrow(AppError);
    }
  });

  it('accepts RTSP only where a stream URL is expected', () => {
    expect(() => assertSafeUpstreamUrl('rtsp://mediamtx:8554', 'Frigate URL')).toThrow(AppError);
    expect(
      assertSafeUpstreamUrl('rtsp://mediamtx:8554', 'RTSP base URL', {
        protocols: ['rtsp:', 'rtsps:'],
      }),
    ).toBe('rtsp://mediamtx:8554');
  });

  it('rejects a value that is not a URL at all', () => {
    expect(() => assertSafeUpstreamUrl('frigate:5000', 'Frigate URL')).toThrow(AppError);
    expect(() => assertSafeUpstreamUrl('   ', 'Frigate URL')).toThrow(AppError);
  });

  it('allows an empty value only where the field is optional', () => {
    expect(assertSafeUpstreamUrl('', 'go2rtc URL', { allowEmpty: true })).toBe('');
    expect(() => assertSafeUpstreamUrl('', 'go2rtc URL')).toThrow(AppError);
  });

  it('names the field in the message, so the operator knows which box to fix', () => {
    try {
      assertSafeUpstreamUrl('file:///etc/hosts', 'go2rtc URL');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).message).toContain('go2rtc URL');
    }
  });
});

describe('assertSafeSettings', () => {
  it('checks every URL field a provider declares', () => {
    expect(() =>
      assertSafeSettings([field()], { baseUrl: 'http://169.254.169.254' }),
    ).toThrow(AppError);
  });

  it('ignores fields that are not URLs', () => {
    expect(() =>
      assertSafeSettings([field({ key: 'mode', label: 'Discovery', type: 'text' })], {
        mode: 'anything at all',
      }),
    ).not.toThrow();
  });

  it('lets an optional URL be blank but still requires a required one', () => {
    expect(() =>
      assertSafeSettings([field({ key: 'go2rtcUrl', label: 'go2rtc URL', required: false })], {}),
    ).not.toThrow();
    expect(() => assertSafeSettings([field()], {})).toThrow(AppError);
  });

  it('permits RTSP in a field named for it', () => {
    expect(() =>
      assertSafeSettings([field({ key: 'rtspBaseUrl', label: 'RTSP base URL' })], {
        rtspBaseUrl: 'rtsp://lostblink-mediamtx:8554',
      }),
    ).not.toThrow();
  });
});
