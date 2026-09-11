/**
 * What someone does here.
 *
 * 'admin' is the account owner. The rest are the roster, and they are not
 * interchangeable: only some of them ever stand at a till, and only some of them should
 * appear in a sales figure. What each one is allowed to do is defined once, in
 * utils/roles.ts — ask it rather than comparing against a role here.
 *
 * 'other' is the catch-all for everyone on the payroll who is none of the above, so a
 * restaurant is never forced to file a cleaner as a cashier to get them on the roster.
 */
export type UserRole = 'admin' | 'cashier' | 'server' | 'kitchen' | 'storekeeper' | 'other';
export type UserStatus = 'active' | 'deactivated';

export interface UserAccount {
  id: string;              // Unique User ID (UUID)
  name: string;            // Full Name
  email: string;           // Email Address
  username: string;        // Username or Email
  passwordHash?: string;   // Salted Password Hash
  passwordSalt?: string;   // 16-byte random salt for password
  pinHash: string;         // Salted PIN Hash
  pinSalt: string;         // 16-byte random salt for PIN
  /**
   * Salted hash of the admin's offline master recovery key, or null once the key has been
   * spent. Explicitly nullable, not merely optional: clearing it has to travel to the
   * cloud as `null`, because an `undefined` is dropped by JSON.stringify on the way to
   * Supabase — leaving the old hash in place, to be pulled back down and resurrect a key
   * that was supposed to be single-use.
   */
  recoveryKeyHash?: string | null;
  recoveryKeySalt?: string | null;
  role: UserRole;          // See utils/roles.ts for what each one may do
  createdAt: string;       // ISO 8601 string
  status: UserStatus;
  /** Owning account: the admin's Supabase auth user id, and the tenant key the
   *  whole sync layer scopes by. */
  accountId?: string;
  /** Server-authoritative, set by the Postgres trigger — used for last-write-wins
   *  merges when reconciling remote changes into the local copy. */
  updatedAt?: string;
}

export interface AuthSession {
  user: UserAccount;
  token: string;
  loginAt: string;
}
