import { create } from 'zustand';
import { UserAccount, UserRole } from '../types/user';
import { generateSalt, hashSecretWithSalt, verifySecret, generateMasterRecoveryKey } from '../services/auth/pinAuth';
import { dbService } from '../services/db/LocalStorageDbService';
import { authenticateAdminWithSupabase, supabase } from '../services/supabase/supabaseClient';

interface AuthState {
  users: UserAccount[];
  activeUser: UserAccount | null;
  isAuthenticated: boolean;
  isLoaded: boolean;
  
  isPinModalOpen: boolean;
  pinModalPurpose: string | null;
  pinChallengeCallback: ((success: boolean) => void) | null;

  loadUsers: () => Promise<void>;
  registerUser: (name: string, email: string, password: string, pin: string, role?: UserRole) => Promise<UserAccount>;
  loginUser: (email: string, passwordOrPin: string) => Promise<boolean>;
  logoutUser: () => Promise<void>;
  
  updateAdminProfile: (userId: string, name: string, email: string, newPin?: string) => Promise<boolean>;
  createStaffCashier: (name: string, username: string, pin: string) => Promise<UserAccount>;
  resetCashierPin: (cashierId: string, newPin: string) => Promise<boolean>;
  recoverAdminPinWithKey: (usernameOrEmail: string, recoveryKey: string, newPin: string) => Promise<boolean>;
  switchCashierSession: (userId: string, pin: string) => Promise<boolean>;
  
  openPinModal: (purpose: string, onVerify: (success: boolean) => void) => void;
  closePinModal: () => void;
  validatePin: (pin: string) => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  users: [],
  activeUser: null,
  isAuthenticated: false,
  isLoaded: false,

  isPinModalOpen: false,
  pinModalPurpose: null,
  pinChallengeCallback: null,

  loadUsers: async () => {
    await dbService.init();
    const users = await dbService.getUsers();
    
    // Check if session token exists in localStorage
    const savedUserId = localStorage.getItem('ticket_pos_session_user_id');
    let activeUser: UserAccount | null = null;
    let isAuthenticated = false;

    if (savedUserId) {
      activeUser = users.find(u => u.id === savedUserId && u.status === 'active') || null;
      if (activeUser) isAuthenticated = true;
    }

    set({
      users: users.filter(u => u.status === 'active'),
      activeUser,
      isAuthenticated,
      isLoaded: true,
    });
  },

  registerUser: async (name: string, email: string, password: string, pin: string, role: UserRole = 'admin') => {
    const cleanEmail = email.trim().toLowerCase();
    
    // Check if account already exists
    const existing = await dbService.getUserByEmail(cleanEmail);
    if (existing) {
      throw new Error(`An account with email "${cleanEmail}" already exists. Please log in instead.`);
    }

    // Try Supabase Auth Cloud Registration if online & configured
    try {
      await authenticateAdminWithSupabase(cleanEmail, pin);
    } catch (e) {
      // Fallback to local cryptographic registration if unconfigured
    }

    // Generate salted credentials for password and PIN
    const passwordSalt = generateSalt();
    const passwordHash = await hashSecretWithSalt(password, passwordSalt);

    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(pin, pinSalt);

    const newUser: UserAccount = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: cleanEmail,
      username: cleanEmail,
      passwordHash,
      passwordSalt,
      pinHash,
      pinSalt,
      role,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    await dbService.saveUser(newUser);
    localStorage.setItem('ticket_pos_session_user_id', newUser.id);

    set({
      activeUser: newUser,
      isAuthenticated: true,
    });

    await get().loadUsers();
    return newUser;
  },

  loginUser: async (email: string, passwordOrPin: string) => {
    const cleanEmail = email.trim().toLowerCase();
    const user = await dbService.getUserByEmail(cleanEmail);
    if (!user) return false;

    // Test secret against both password and PIN salted hashes
    const isPasswordValid = user.passwordHash && user.passwordSalt
      ? await verifySecret(passwordOrPin, user.passwordHash, user.passwordSalt)
      : false;

    const isPinValid = await verifySecret(passwordOrPin, user.pinHash, user.pinSalt);

    if (isPasswordValid || isPinValid) {
      localStorage.setItem('ticket_pos_session_user_id', user.id);
      set({
        activeUser: user,
        isAuthenticated: true,
      });
      return true;
    }

    return false;
  },

  logoutUser: async () => {
    try {
      if (navigator.onLine && supabase) {
        await supabase.auth.signOut();
      }
    } catch (e) {}

    localStorage.removeItem('ticket_pos_session_user_id');
    set({
      activeUser: null,
      isAuthenticated: false,
    });
  },

  updateAdminProfile: async (userId: string, name: string, email: string, newPin?: string) => {
    const user = get().users.find(u => u.id === userId);
    if (!user) return false;

    const cleanEmail = email.trim().toLowerCase();
    let pinHash = user.pinHash;
    let pinSalt = user.pinSalt;

    if (newPin && newPin.length >= 4) {
      pinSalt = generateSalt();
      pinHash = await hashSecretWithSalt(newPin, pinSalt);
    }

    const updatedUser: UserAccount = {
      ...user,
      name: name.trim(),
      email: cleanEmail,
      username: cleanEmail,
      pinHash,
      pinSalt,
    };

    await dbService.updateUser(updatedUser);
    set({ activeUser: updatedUser });
    await get().loadUsers();
    return true;
  },

  createStaffCashier: async (name: string, username: string, pin: string) => {
    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(pin, pinSalt);
    const passwordSalt = generateSalt();
    const passwordHash = await hashSecretWithSalt(pin, passwordSalt);

    const cashierUser: UserAccount = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: username.trim().toLowerCase(),
      username: username.trim().toLowerCase(),
      passwordHash,
      passwordSalt,
      pinHash,
      pinSalt,
      role: 'cashier',
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

    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(newPin, pinSalt);
    
    const updatedUser: UserAccount = {
      ...user,
      pinHash,
      pinSalt,
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

    const isValidKey = await verifySecret(cleanKey, user.recoveryKeyHash, user.recoveryKeySalt);
    if (!isValidKey) return false;

    const newSalt = generateSalt();
    const newPinHash = await hashSecretWithSalt(newPin, newSalt);

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

    const isValid = await verifySecret(pin, user.pinHash, user.pinSalt);
    if (isValid) {
      localStorage.setItem('ticket_pos_session_user_id', user.id);
      set({ activeUser: user });
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
      const match = await verifySecret(pin, admin.pinHash, admin.pinSalt);
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
