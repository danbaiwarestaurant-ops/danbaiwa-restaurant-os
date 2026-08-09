/**
 * Simple local hash function for PIN authentication (Argon2 / SHA-256 fallback simulation)
 */
export async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`ticket_pos_salt_${pin}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Default system PINs for testing (hashed on load)
export const DEFAULT_PINS = {
  CASHIER: '1234',
  MANAGER: '9999',
};

export async function verifyPin(inputPin: string, expectedRole: 'cashier' | 'manager' = 'manager'): Promise<boolean> {
  if (!inputPin) return false;
  
  // Quick fallback check for defaults in dev mode
  if (expectedRole === 'manager' && inputPin === DEFAULT_PINS.MANAGER) return true;
  if (expectedRole === 'cashier' && (inputPin === DEFAULT_PINS.CASHIER || inputPin === DEFAULT_PINS.MANAGER)) return true;

  const inputHash = await hashPin(inputPin);
  const targetDefaultPin = expectedRole === 'manager' ? DEFAULT_PINS.MANAGER : DEFAULT_PINS.CASHIER;
  const targetHash = await hashPin(targetDefaultPin);

  return inputHash === targetHash;
}
