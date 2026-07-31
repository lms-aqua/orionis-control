import { describe, expect, it } from 'vitest';
import { validateRule } from '../../src/adapters/adguard/http.ts';

describe('custom filtering rule validation', () => {
  it('accepts adblock-style block rules', () => {
    expect(validateRule('||ads.example.com^')).toEqual({
      ok: true,
      normalised: '||ads.example.com^',
    });
    expect(validateRule('||tracker.example.com^$third-party').ok).toBe(true);
  });

  it('accepts allow rules', () => {
    expect(validateRule('@@||cdn.example.com^').ok).toBe(true);
  });

  it('accepts hosts-style and regex rules', () => {
    expect(validateRule('0.0.0.0 ads.example.com').ok).toBe(true);
    expect(validateRule('/^ads?\\./').ok).toBe(true);
  });

  it('accepts comments', () => {
    expect(validateRule('! this is a comment').ok).toBe(true);
    expect(validateRule('# also a comment').ok).toBe(true);
  });

  it('accepts a bare domain', () => {
    expect(validateRule('example.com').ok).toBe(true);
  });

  it('rejects empty and whitespace-only rules', () => {
    expect(validateRule('')).toEqual({ ok: false, reason: 'The rule is empty.' });
    expect(validateRule('    ').ok).toBe(false);
  });

  it('rejects rules longer than 512 characters', () => {
    const result = validateRule(`||${'a'.repeat(600)}.com^`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('512');
  });

  it('rejects rules containing control characters', () => {
    const result = validateRule('||evil.com^\u0007injected');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('control characters');
  });

  it('rejects unrecognised syntax rather than forwarding it upstream', () => {
    const result = validateRule('DROP TABLE filters;');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Unrecognised rule syntax');
  });

  it('trims surrounding whitespace when normalising', () => {
    const result = validateRule('   ||ads.example.com^   ');
    expect(result).toEqual({ ok: true, normalised: '||ads.example.com^' });
  });
});
