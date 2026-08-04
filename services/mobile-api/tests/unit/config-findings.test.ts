/**
 * Startup findings, and the promise that `.env.example` documents every setting.
 *
 * An unset upstream is a legitimate deployment here, so most of these are
 * warnings rather than errors. That makes the banner the only place a dropped
 * variable is named — silence would leave it looking like missing data.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONFIG_KEYS, formatFindings, loadConfig } from '../../src/config/env.ts';
import { testEnv } from '../helpers/harness.ts';

const ENV_EXAMPLE = new URL('../../../../.env.example', import.meta.url);

const withOrionis = (overrides: Record<string, string> = {}) =>
  testEnv({ ORIONIS_INTERNAL_URL: 'http://orionis.invalid:8080', ...overrides });

describe('recorder configuration findings', () => {
  it('warns that recordings are empty when no playback server is configured', () => {
    const { config, findings } = loadConfig(withOrionis());
    expect(config.orionis.recordingsBaseUrl).toBe('');

    const finding = findings.find((f) => f.key === 'ORIONIS_RECORDINGS_BASE_URL');
    expect(finding).toBeDefined();
    expect(finding!.level).toBe('warn');
    // The banner has to connect the setting to what the operator will actually
    // see in the app, or an empty timeline reads as a broken recorder.
    expect(finding!.message).toContain('Nothing was recorded on this day');
    expect(formatFindings(findings)).toContain(
      `[config:warn] ORIONIS_RECORDINGS_BASE_URL — ${finding!.message}`,
    );
  });

  it('stays quiet once a playback server is configured', () => {
    const { config, findings } = loadConfig(
      withOrionis({ ORIONIS_RECORDINGS_BASE_URL: 'http://orionis-hls.invalid:9996/' }),
    );
    expect(config.orionis.recordingsBaseUrl).toBe('http://orionis-hls.invalid:9996');
    expect(findings.find((f) => f.key === 'ORIONIS_RECORDINGS_BASE_URL')).toBeUndefined();
  });

  it('does not name the recorder when there is no Orionis upstream at all', () => {
    // ORIONIS_INTERNAL_URL already explains that every camera route is
    // unconfigured. Adding a recorder warning underneath it is noise.
    const { findings } = loadConfig(testEnv());
    expect(findings.find((f) => f.key === 'ORIONIS_INTERNAL_URL')).toBeDefined();
    expect(findings.find((f) => f.key === 'ORIONIS_RECORDINGS_BASE_URL')).toBeUndefined();
  });

  it('never reports a recorder finding as blocking', () => {
    // A deployment with cameras but no recorder must still start.
    const { findings } = loadConfig(withOrionis({ NODE_ENV: 'production' }));
    const finding = findings.find((f) => f.key === 'ORIONIS_RECORDINGS_BASE_URL');
    expect(finding?.level).toBe('warn');
  });
});

describe('.env.example', () => {
  it('documents every setting the gateway reads', () => {
    const documented = new Set(
      readFileSync(ENV_EXAMPLE, 'utf8')
        .split('\n')
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
        .filter((key): key is string => Boolean(key)),
    );
    const undocumented = CONFIG_KEYS.filter((key) => !documented.has(key));
    expect(undocumented).toEqual([]);
  });
});
