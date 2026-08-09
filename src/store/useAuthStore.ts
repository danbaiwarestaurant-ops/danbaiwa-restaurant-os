import { create } from 'zustand';
import { UserAccount, UserRole } from '../types/user';
import { generateSalt, hashPinWithSalt, verifyUserPin, generateMasterRecoveryKey } from '../services/auth/pinAuth';
import { dbService } from '../services/db/LocalStorageDbService';

interface AuthState {
  users: UserAccount[];
  activeCashier: UserAccount | null;
  hasAdminAccount: boolean;
  isLoaded: boolean;
  
  isPinModalOpen: boolean;
  pinModalPurpose: string | null;
  pinChallengeCallback: ((success: boolean) => void) | null;

  loadUsers: () => Promise<void>;
  createFirstAdmin: (name: string, username: string, pin: string) => Promise<{ admin: UserAccount; recoveryKey: string }>;
  createStaffCashier: (name: string, username: string, pin: string) => Promise<UserAccount>;
  resetCashierPin: (cashierId: string, newPin: string) => Promise<boolean>;
  recoverAdminPinWithKey: (username: string, recoveryKey: string, newPin: string) => Promise<boolean>;
  switchCashierSession: (userId: string, pin: string) => Promise<boolean>;
  openPinModal: (purpose: string, onVerify: (success: boolean) => void) => void;
  closePinModal: () => void;
  validatePin: (pin: string) => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  users: [],
  activeCashier: null,
  hasAdminAccount: false,
  isLoaded: false,

  isPinModalOpen: false,
  pinModalPurpose: null,
  pinChallengeCallback: null,

  loadUsers: async () => {
    await dbService.init();
    const users = await dbService.getUsers();
    const activeUsers = users.filter(u => u.status === 'active');
    const adminExists = activeUsers.some(u => u.role === 'admin');

    const currentActive = get().activeCashier;
    const nextActive = currentActive 
      ? activeUsers.find(u => u.id === currentActive.id) || activeUsers[0] || null
      : activeUsers[0] || null;

    set({
      users: activeUsers,
      activeCashier: nextActive,
      hasAdminAccount: adminExists,
      isLoaded: true,
    });
  },

  createFirstAdmin: async (name: string, username: string, pin: string) => {
    const salt = generateSalt();
    const pinHash = await hashPinWithSalt(pin, salt);
    
    const recoveryKey = generateMasterRecoveryKey();
    const recoverySalt = generateSalt();
    const recoveryKeyHash = await hashPinWithSalt(recoveryKey.replace(/-/g, ''), recoverySalt);

    const adminUser: UserAccount = {
      id: crypto.randomUUID(),
      name: name.trim(),
      username: username.trim().toLowerCase(),
      role: 'admin',
      pinHash,
      pinSalt: salt,
      recoveryKeyHash,
      recoveryKeySalt: recoverySalt,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    await dbService.saveUser(adminUser);
    await get().loadUsers();
    return { admin: adminUser, recoveryKey };
  },

  createStaffCashier: async (name: string, username: string, pin: string) => {
    const salt = generateSalt();
    const pinHash = await hashPinWithSalt(pin, salt);

    const cashierUser: UserAccount = {
      id: crypto.randomUUID(),
      name: name.trim(),
      username: username.trim().toLowerCase(),
      role: 'cashier',
      pinHash,
      pinSalt: salt,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    await dbService.saveUser(cashierUser);
    await get().loadUsers();
    return cashierUser;
  },

  resetCashierPin: async (cashierId: string, newPin: string) => {
    const user = get().users.find(u => u.id === cashierId);
    if (!user) return false;

    const salt = generateSalt();
    const pinHash = await hashPinWithSalt(newPin, salt);
    
    const updatedUser: UserAccount = {
      ...user,
      pinHash,
      pinSalt: salt,
    };

    await dbService.updateUser(updatedUser);
    await get().loadUsers();
    return true;
  },

  recoverAdminPinWithKey: async (username: string, recoveryKey: string, newPin: string) => {
    const cleanUsername = username.trim().toLowerCase();
    const cleanKey = recoveryKey.trim().toUpperCase().replace(/-/g, '');
    
    const user = get().users.find(u => u.username === cleanUsername && u.role === 'admin');
    if (!user || !user.recoveryKeyHash || !user.recoveryKeySalt) return false;

    const isValidKey = await verifyUserPin(cleanKey, user.recoveryKeyHash, user.recoveryKeySalt);
    if (!isValidKey) return false;

    const newSalt = generateSalt();
    const newPinHash = await hashPinWithSalt(newPin, newSalt);

    const updatedAdmin: UserAccount = {
      ...user,
      pinHash: newPinHash,
      pinSalt: newSalt,
    };

    await dbService.updateUser(updatedAdmin);
    await get().loadUsers();
    return true;
  },

  switchCashierSession: async (userId: string, pin: string) => {
    const user = get().users.find(u => u.id === userId);
    if (!user) return false;

    const isValid = await verifyUserPin(pin, user.pinHash, user.pinSalt);
    if (isValid) {
      set({ activeCashier: user });
    }
    return isValid;
  },

  openPinModal: (purpose: string, onVerify: (success: boolean) => void) => {
    set({
      isPinModalOpen: true,
      pinModalPurpose: purpose,
      pinChallengeCallback: onVerify,
    });
  },

  closePinModal: () => {
    set({
      isPinModalOpen: false,
      pinModalPurpose: null,
      pinChallengeCallback: null,
    });
  },

  validatePin: async (pin: string) => {
    const users = get().users;
    const admins = users.filter(u => u.role === 'admin' && u.status === 'active');

    let isValid = false;
    for (const admin of admins) {
      const match = await verifyUserPin(pin, admin.pinHash, admin.pinSalt);
      if (match) {
        isValid = true;
        break;
      }
    }

    const cb = get().pinChallengeCallback;
    if (cb) cb(isValid);
    if (isValid) get().closePinModal();
    return isValid;
  },
}));
