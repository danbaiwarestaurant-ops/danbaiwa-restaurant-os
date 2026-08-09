export type UserRole = 'admin' | 'cashier';
export type UserStatus = 'active' | 'deactivated';

export interface UserAccount {
  id: string; // client UUID
  name: string;
  username: string;
  role: UserRole;
  pinHash: string;
  pinSalt: string;
  recoveryKeyHash?: string;
  recoveryKeySalt?: string;
  createdAt: string; // ISO 8601 string
  status: UserStatus;
}
