import { describe, it, expect } from 'vitest';
import { generateRecoveryKey, normaliseRecoveryKey, looksLikeRecoveryKey } from '../utils/recoveryKey';

describe('generateRecoveryKey', () => {
  it('is formatted for reading off a card', () => {
    expect(generateRecoveryKey()).toMatch(/^DANB-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('never uses the characters that get mis-transcribed by hand', () => {
    // I/L against 1, O against 0, and U because it turns keys into words.
    const keys = Array.from({ length: 200 }, generateRecoveryKey).join('');
    expect(keys).not.toMatch(/[ILOU]/);
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 500 }, generateRecoveryKey));
    expect(keys.size).toBe(500);
  });
});

describe('normaliseRecoveryKey', () => {
  it('accepts the key exactly as issued', () => {
    expect(normaliseRecoveryKey('DANB-7F3K-9QRT-2XZM')).toBe('DANB7F3K9QRT2XZM');
  });

  it('forgives what goes wrong between a pen and a keyboard', () => {
    const canonical = normaliseRecoveryKey('DANB-7F3K-9QRT-2XZM');
    // lower case, missing dashes, stray spaces
    expect(normaliseRecoveryKey('danb7f3k9qrt2xzm')).toBe(canonical);
    expect(normaliseRecoveryKey('  DANB 7F3K 9QRT 2XZM  ')).toBe(canonical);
    expect(normaliseRecoveryKey('DANB--7F3K--9QRT--2XZM')).toBe(canonical);
  });

  it('reads a hand-written I, l or O as the digit it was meant to be', () => {
    // The alphabet contains no I/L/O, so any of them is a transcription slip.
    expect(normaliseRecoveryKey('DANB-7F3K-9QRT-2XZI')).toBe('DANB7F3K9QRT2XZ1');
    expect(normaliseRecoveryKey('DANB-7F3K-9QRT-2XZl')).toBe('DANB7F3K9QRT2XZ1');
    expect(normaliseRecoveryKey('DANB-7F3K-9QRT-2XZO')).toBe('DANB7F3K9QRT2XZ0');
  });

  it('does not mangle the DANB prefix', () => {
    expect(normaliseRecoveryKey(generateRecoveryKey())).toMatch(/^DANB/);
  });

  it('returns empty for nothing, rather than throwing', () => {
    expect(normaliseRecoveryKey('')).toBe('');
    expect(normaliseRecoveryKey(undefined as any)).toBe('');
  });
});

describe('looksLikeRecoveryKey', () => {
  it('accepts every issued key', () => {
    for (let i = 0; i < 50; i++) {
      expect(looksLikeRecoveryKey(generateRecoveryKey())).toBe(true);
    }
  });

  it('rejects the wrong shape before any hashing is attempted', () => {
    expect(looksLikeRecoveryKey('DANB-7F3K-9QRT')).toBe(false);       // too short
    expect(looksLikeRecoveryKey('DANB-7F3K-9QRT-2XZM-99')).toBe(false); // too long
    expect(looksLikeRecoveryKey('XXXX-7F3K-9QRT-2XZM')).toBe(false);  // wrong prefix
    expect(looksLikeRecoveryKey('')).toBe(false);
  });
});
