/**
 * recoveryKey.ts
 *
 * The admin's offline break-glass key: the way back into a till when the PIN has been
 * forgotten and there is no internet to run an email reset.
 *
 * Only a salted hash is ever stored, so the key cannot be read back off the device or out
 * of the cloud — it exists exactly once, at the moment it is issued, and has to be written
 * down then.
 *
 * Crockford's base32 alphabet: no I, L, O or U. Those are the characters that get
 * mis-transcribed from a slip of paper (1/I/l, 0/O) or accidentally spell words, and this
 * key's whole purpose is to be copied by hand under pressure and typed back in months
 * later.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'DANB';
const GROUPS = 3;
const GROUP_LEN = 4;

/**
 * A new key, formatted as DANB-XXXX-XXXX-XXXX.
 *
 * 12 characters of a 32-symbol alphabet is 60 bits — far past guessing, and still short
 * enough to write on a card and tape inside the till.
 */
export function generateRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GROUPS * GROUP_LEN));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(chars.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(''));
  }
  return [PREFIX, ...groups].join('-');
}

/**
 * The canonical form of a key as typed by a human — what is hashed, and what is compared.
 *
 * Forgiving about the things that go wrong between a pen and a keyboard: case, spaces,
 * missing or extra dashes, and the letters Crockford's alphabet leaves out precisely
 * because they are confused with digits (I and L read back as 1, O as 0).
 */
export function normaliseRecoveryKey(input: string): string {
  return (input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/** Whether a typed key is even the right shape, before any hashing is attempted. */
export function looksLikeRecoveryKey(input: string): boolean {
  const clean = normaliseRecoveryKey(input);
  return clean.length === PREFIX.length + GROUPS * GROUP_LEN && clean.startsWith(PREFIX);
}
