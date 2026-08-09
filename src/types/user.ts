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
  recoveryKeyHash?: string;// Master Recovery Key Hash
  recoveryKeySalt?: string;// Master Recovery Key Salt
  role: UserRole;          // Admin or Cashier
  createdAt: string;       // ISO 8601 string
  status: UserStatus;
}

export interface AuthSession {
  user: UserAccount;
  token: string;
  loginAt: string;
}
