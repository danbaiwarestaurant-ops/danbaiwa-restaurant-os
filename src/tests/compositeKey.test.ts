import { describe, it, expect } from 'vitest';
import { generateCompositeKey, parseCompositeKey } from '../utils/compositeKey';

describe('Composite Ticket Key Generator', () => {
  it('should generate composite primary key with padded sequence', () => {
    const key = generateCompositeKey('LOC01', 'DEV01', 42);
    expect(key).toBe('LOC01-DEV01-000042');
  });

  it('should uppercase location and device identifiers', () => {
    const key = generateCompositeKey('loc_north', 'dev_pos1', 7);
    expect(key).toBe('LOC_NORTH-DEV_POS1-000007');
  });

  it('should parse valid composite key correctly', () => {
    const parsed = parseCompositeKey('LOC01-DEV01-000042');
    expect(parsed).toEqual({
      locationId: 'LOC01',
      deviceId: 'DEV01',
      localSeq: 42,
    });
  });

  it('should return null for malformed composite keys', () => {
    expect(parseCompositeKey('INVALIDKEY')).toBeNull();
    expect(parseCompositeKey('LOC01-DEV01-NOTANUMBER')).toBeNull();
  });
});
