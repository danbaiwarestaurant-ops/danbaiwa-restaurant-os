/**
 * Cryptographic PIN Authentication Engine & Recovery System
 * - Zero hardcoded PINs or literal fallbacks in source code.
 * - Per-user 16-byte cryptographically secure random salt (crypto.getRandomValues).
 * - Master Offline Recovery Key (24-char formatted string) for Admin emergency PIN resets.
 * - Admin Reset of Staff Cashier PINs.
 */

export function generateSalt(): string {
  const saltArray = new Uint8Array(16);
  crypto.getRandomValues(saltArray);
  return Array.from(saltArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateMasterRecoveryKey(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Base32 unambiguous uppercase
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  
  let key = 'DANB-';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars[array[i] % chars.length];
  }
  return key; // e.g. DANB-98A2-K47L-M29P
}

export async function hashPinWithSalt(pin: string, salt: string): Promise<string> {
  if (!pin || !salt) throw new Error('PIN and Salt are required for cryptographic hashing');
  const encoder = new TextEncoder();
  const data = encoder.encode(`danbaiwa_pos_salt_${salt}_pin_${pin}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyUserPin(
  inputPin: string,
  storedHash: string,
  storedSalt: string
): Promise<boolean> {
  if (!inputPin || !storedHash || !storedSalt) return false;
  const computedHash = await hashPinWithSalt(inputPin, storedSalt);
  return computedHash === storedHash;
}
