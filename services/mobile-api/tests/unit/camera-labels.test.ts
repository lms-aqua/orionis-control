import { describe, expect, it } from 'vitest';
import { parseCameraLabels } from '../../src/config/env.ts';

describe('parseCameraLabels', () => {
  it('maps opaque upstream ids to a name and optional location', () => {
    expect(parseCameraLabels('57=Driveway|Outside,56=Shed')).toEqual({
      57: { name: 'Driveway', location: 'Outside' },
      56: { name: 'Shed', location: null },
    });
  });

  it('tolerates whitespace and an empty setting', () => {
    expect(parseCameraLabels('  57 = Driveway | Outside  ')).toEqual({
      57: { name: 'Driveway', location: 'Outside' },
    });
    expect(parseCameraLabels('')).toEqual({});
    expect(parseCameraLabels(undefined)).toEqual({});
  });

  it('skips malformed entries rather than inventing a name', () => {
    // No id, no name, and no separator respectively.
    expect(parseCameraLabels('=Driveway,57=,justtext,57=Real')).toEqual({
      57: { name: 'Real', location: null },
    });
  });

  it('keeps names containing an equals sign intact', () => {
    expect(parseCameraLabels('57=Cam=A|Yard')).toEqual({
      57: { name: 'Cam=A', location: 'Yard' },
    });
  });
});
