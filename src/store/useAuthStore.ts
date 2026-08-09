import { create } from 'zustand';
import { UserAccount } from '../types/user';
import { generateSalt, hashPinWithSalt, verifyUserPin, generateMasterRecoveryKey } from '../services/auth/pinAuth';
import { dbService } from '../services/db/LocalStorageDbService';
import { authenticateAdminWithSupabase, supabase } from '../services/supabase/supabaseClient';

interface AuthState {
  users: UserAccount[];
  activeCashier: UserAccount | null;
  hasAdminAccount: boolean;
  isLoaded: boolean;
  
  isPinModalOpen: boolean;
  pinModalPurpose: string | null;
  pinChallengeCallback: ((success: boolean) => void) | null;

  loadUsers: () => Promise<void>;
  createFirstAdmin: (name: string, email: string, pin: string) => Promise<{ admin: UserAccount; recoveryKey: string }>;
  updateAdminProfile: (userId: string, name: string, email: string, newPin?: string) => Promise<boolean>;
  createStaffCashier: (name: string, username: string, pin: string) => Promise<UserAccount>;
  resetCashierPin: (cashierId: string, newPin: string) => Promise<boolean>;
  recoverAdminPinWithKey: (usernameOrEmail: string, recoveryKey: string, newPin: string) => Promise<boolean>;
  switchCashierSession: (userId: string, pin: string) => Promise<boolean>;
  logoutUser: () => Promise<void>;
  systemLogout: () => Promise<void>;
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
    
    // Load local accounts
    let users = await dbService.getUsers();

    // Check if Supabase or Shared Sync outbox contains pre-existing accounts
    const outboxItems = await dbService.getPendingOutbox();
    const userMutations = outboxItems.filter(o => o.tableName === 'users' && o.payload);
    
    for (const item of userMutations) {
      const u = item.payload as UserAccount;
      if (!users.some(existing => existing.id === u.id || existing.username === u.username)) {
        users.push(u);
      }
    }

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

  createFirstAdmin: async (name: string, email: string, pin: string) => {
    const cleanEmail = email.trim().toLowerCase();

    // 1. Perform REAL Supabase Auth GoTrue cloud authentication
    const supabaseAuthResult = await authenticateAdminWithSupabase(cleanEmail, pin);

    // 2. Generate salted credentials for local SQLite offline continuity
    const salt = generateSalt();
    const pinHash = await hashPinWithSalt(pin, salt);
    
    const recoveryKey = generateMasterRecoveryKey();
    const recoverySalt = generateSalt();
    const recoveryKeyHash = await hashPinWithSalt(recoveryKey.replace(/-/g, ''), recoverySalt);

    const adminUser: UserAccount = {
      id: supabaseAuthResult.userId || crypto.randomUUID(),
      name: name.trim(),
      username: cleanEmail,
      email: cleanEmail,
      role: 'admin',
      pinHash,
      pinSalt: salt,
      recoveryKeyHash,
      recoveryKeySalt: recoverySalt,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    // Save to local SQLite database so subsequent launches run 100% offline
    await dbService.saveUser(adminUser);
    await get().loadUsers();
    return { admin: adminUser, recoveryKey };
  },

  updateAdminProfile: async (userId: string, name: string, email: string, newPin?: string) => {
    const user = get().users.find(u => u.id === userId && u.role === 'admin');
    if (!user) return false;

    const cleanEmail = email.trim().toLowerCase();
    let pinHash = user.pinHash;
    let pinSalt = user.pinSalt;

    if (newPin && newPin.length >= 4) {
      pinSalt = generateSalt();
      pinHash = await hashPinWithSalt(newPin, pinSalt);
    }

    const updatedAdmin: UserAccount = {
      ...user,
      name: name.trim(),
      username: cleanEmail,
      email: cleanEmail,
      pinHash,
      pinSalt,
    };

    await dbService.updateUser(updatedAdmin);
    await get().loadUsers();
    return true;
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

  recoverAdminPinWithKey: async (usernameOrEmail: string, recoveryKey: string, newPin: string) => {
    const target = usernameOrEmail.trim().toLowerCase();
    const cleanKey = recoveryKey.trim().toUpperCase().replace(/-/g, '');
    
    const user = get().users.find(u => (u.username === target || u.email === target) && u.role === 'admin');
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

  logoutUser: async () => {
    try {
      if (navigator.onLine && supabase) {
        await supabase.auth.signOut();
      }
    } catch (e) {
      // Ignore offline signout errors
    }
    set({ activeCashier: null });
  },

  systemLogout: async () => {
    try {
      if (navigator.onLine && supabase) {
        await supabase.auth.signOut();
      }
    } catch (e) {
      // Ignore offline signout errors
    }
    
    // Perform complete system logout & reset active cashier and admin flags
    set({
      activeCashier: null,
      hasAdminAccount: false,
      users: [],
    });
    localStorage.removeItem('ticket_pos_users');
    window.location.reload();
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
