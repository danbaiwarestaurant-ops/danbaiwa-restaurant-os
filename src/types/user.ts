export type UserRole = 'admin' | 'cashier';
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
  role: UserRole;          // Admin or Cashier
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
