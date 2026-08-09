/**
 * Enterprise Cryptographic Authentication Engine
 * - Zero hardcoded credentials or plaintext fallbacks.
 * - Per-user 16-byte cryptographically secure random salt (crypto.getRandomValues).
 * - Salted SHA-256 password & PIN verification.
 */

export function generateSalt(): string {
  const saltArray = new Uint8Array(16);
  crypto.getRandomValues(saltArray);
  return Array.from(saltArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateMasterRecoveryKey(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  
  let key = 'DANB-';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars[array[i] % chars.length];
  }
  return key;
}

export async function hashSecretWithSalt(secret: string, salt: string): Promise<string> {
  if (!secret || !salt) throw new Error('Secret and Salt are required for hashing');
  const encoder = new TextEncoder();
  const data = encoder.encode(`danbaiwa_pos_salt_${salt}_secret_${secret}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySecret(
  inputSecret: string,
  storedHash: string,
  storedSalt: string
): Promise<boolean> {
  if (!inputSecret || !storedHash || !storedSalt) return false;
  const computedHash = await hashSecretWithSalt(inputSecret, storedSalt);
  return computedHash === storedHash;
}

// Alias helper functions for backward compatibility
export const hashPinWithSalt = hashSecretWithSalt;
export const verifyUserPin = verifySecret;
