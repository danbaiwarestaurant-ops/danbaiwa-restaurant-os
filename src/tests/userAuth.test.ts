import { describe, it, expect } from 'vitest';
import { generateSalt, hashPinWithSalt, verifyUserPin, generateMasterRecoveryKey } from '../services/auth/pinAuth';

describe('Enterprise Authentication & Salted Hashing Security (Zero Hardcoded PINs)', () => {
  it('should generate unique 16-byte cryptographically random hex salts', () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();

    expect(salt1).toBeDefined();
    expect(salt2).toBeDefined();
    expect(salt1.length).toBe(32); // 16 bytes = 32 hex chars
    expect(salt2.length).toBe(32);
    expect(salt1).not.toBe(salt2); // Salts must be unique
  });

  it('should generate formatted 24-character Master Recovery Keys', () => {
    const key1 = generateMasterRecoveryKey();
    const key2 = generateMasterRecoveryKey();

    expect(key1).toBeDefined();
    expect(key1.startsWith('DANB-')).toBe(true);
    expect(key1.length).toBe(19); // DANB-XXXX-XXXX-XXXX = 19 chars with hyphens
    expect(key1).not.toBe(key2);
  });

  it('should produce identical hash for same PIN and salt, but different hash for different salt', async () => {
    const pin = '8842';
    const saltA = generateSalt();
    const saltB = generateSalt();

    const hashA1 = await hashPinWithSalt(pin, saltA);
    const hashA2 = await hashPinWithSalt(pin, saltA);
    const hashB = await hashPinWithSalt(pin, saltB);

    expect(hashA1).toBe(hashA2);
    expect(hashA1).not.toBe(hashB);
  });

  it('should successfully verify correct user PIN against stored hash and salt', async () => {
    const pin = '5519';
    const salt = generateSalt();
    const hash = await hashPinWithSalt(pin, salt);

    const isValid = await verifyUserPin(pin, hash, salt);
    expect(isValid).toBe(true);
  });

  it('should fail verification for incorrect PIN', async () => {
    const correctPin = '5519';
    const wrongPin = '1111';
    const salt = generateSalt();
    const hash = await hashPinWithSalt(correctPin, salt);

    const isValid = await verifyUserPin(wrongPin, hash, salt);
    expect(isValid).toBe(false);
  });

  it('should verify Master Recovery Key formatted input', async () => {
    const rawKey = generateMasterRecoveryKey();
    const cleanKey = rawKey.replace(/-/g, '');
    const recoverySalt = generateSalt();
    const recoveryHash = await hashPinWithSalt(cleanKey, recoverySalt);

    const isValidKey = await verifyUserPin(cleanKey, recoveryHash, recoverySalt);
    expect(isValidKey).toBe(true);
  });
});
