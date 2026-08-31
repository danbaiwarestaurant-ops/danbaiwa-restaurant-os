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

  it('should parse a legacy 3-part key correctly', () => {
    const parsed = parseCompositeKey('LOC01-DEV01-000042');
    expect(parsed).toEqual({
      locationId: 'LOC01',
      deviceId: 'DEV01',
      installationId: undefined,
      localSeq: 42,
    });
  });

  it('should return null for malformed composite keys', () => {
    expect(parseCompositeKey('INVALIDKEY')).toBeNull();
    expect(parseCompositeKey('LOC01-DEV01-NOTANUMBER')).toBeNull();
  });

  describe('installation segment', () => {
    it('keeps two tills apart even when they share location, device AND sequence', () => {
      // The situation the segment exists for: locationId and deviceId are account-level
      // settings that follow the admin to every device, and each till counts from 1.
      // Without the segment both of these are 'LOC01-DEV01-000001', and the outbox's
      // upsert(onConflict:'id') would silently overwrite one ticket with the other.
      const tillA = generateCompositeKey('LOC01', 'DEV01', 1, 'K3F9QZ');
      const tillB = generateCompositeKey('LOC01', 'DEV01', 1, 'M7XTBN');

      expect(tillA).toBe('LOC01-DEV01-K3F9QZ-000001');
      expect(tillA).not.toBe(tillB);
    });

    it('round-trips through parseCompositeKey', () => {
      const parsed = parseCompositeKey(generateCompositeKey('LOC01', 'DEV01', 42, 'K3F9QZ'));
      expect(parsed).toEqual({
        locationId: 'LOC01',
        deviceId: 'DEV01',
        installationId: 'K3F9QZ',
        localSeq: 42,
      });
    });

    it('uppercases the installation segment like the other identifiers', () => {
      expect(generateCompositeKey('LOC01', 'DEV01', 5, 'k3f9qz')).toBe('LOC01-DEV01-K3F9QZ-000005');
    });
  });
});
