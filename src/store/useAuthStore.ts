import { create } from 'zustand';
import { UserAccount, UserRole } from '../types/user';
import { generateSalt, hashSecretWithSalt, verifySecret } from '../services/auth/pinAuth';
import { dbService } from '../services/db/SqliteDbService';
import { authenticateAdminWithSupabase, updateSupabaseUserPassword, supabase, isSupabaseConfigured } from '../services/supabase/supabaseClient';
import { useDeviceStore } from './useDeviceStore';
import { useSyncStore } from './useSyncStore';

interface AuthState {
  users: UserAccount[];
  activeUser: UserAccount | null;
  isAuthenticated: boolean;
  isLoaded: boolean;
  
  // Rate-limiting & Brute-force protection
  failedAttempts: number;
  lockoutUntil: number | null; // Timestamp in ms

  isPinModalOpen: boolean;
  pinModalPurpose: string | null;
  pinChallengeCallback: ((success: boolean) => void) | null;

  loadUsers: () => Promise<void>;
  registerUser: (name: string, email: string, password: string, pin: string, role?: UserRole) => Promise<UserAccount>;
  loginUser: (email: string, passwordOrPin: string) => Promise<boolean>;
  logoutUser: () => Promise<void>;
  
  updateAdminProfile: (userId: string, name: string, email: string, newPin?: string) => Promise<boolean>;
  updatePasswordAfterRecovery: (email: string, newPassword: string, newPin: string) => Promise<boolean>;
  createStaffCashier: (name: string, username: string, pin: string) => Promise<UserAccount>;
  resetCashierPin: (cashierId: string, newPin: string) => Promise<boolean>;
  recoverAdminPinWithKey: (usernameOrEmail: string, recoveryKey: string, newPin: string) => Promise<boolean>;
  switchCashierSession: (userId: string, pin: string) => Promise<boolean>;
  
  openPinModal: (purpose: string, onVerify: (success: boolean) => void) => void;
  closePinModal: () => void;
  validatePin: (pin: string) => Promise<boolean>;
  assertAdminRole: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  users: [],
  activeUser: null,
  isAuthenticated: false,
  isLoaded: false,

  failedAttempts: 0,
  lockoutUntil: null,

  isPinModalOpen: false,
  pinModalPurpose: null,
  pinChallengeCallback: null,

  loadUsers: async () => {
    await dbService.init();
    const users = await dbService.getUsers();
    
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
    
    // 1. Check SQLite local database first
    const existing = await dbService.getUserByEmail(cleanEmail);
    if (existing) {
      throw new Error(`An account with email "${cleanEmail}" already exists. Please log in instead.`);
    }

    // 2. Prevent cloud-side duplicate signup by querying the synced users table
    if (isSupabaseConfigured) {
      const { data: cloudUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', cleanEmail)
        .maybeSingle();

      if (cloudUser) {
        throw new Error(`An account with email "${cleanEmail}" is already registered. Please log in instead.`);
      }
    }

    // 2. Perform Supabase Cloud Signup
    const locationId = useDeviceStore.getState().config.locationId || 'LOC01';
    const supabaseAuthResult = await authenticateAdminWithSupabase(cleanEmail, pin, locationId);

    // 3. Generate per-user cryptographic salts
    const passwordSalt = generateSalt();
    const passwordHash = await hashSecretWithSalt(password, passwordSalt);

    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(pin, pinSalt);

    const newUser: UserAccount = {
      id: supabaseAuthResult.userId || crypto.randomUUID(),
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
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });

    set({
      activeUser: newUser,
      isAuthenticated: true,
      failedAttempts: 0,
      lockoutUntil: null,
    });

    await get().loadUsers();
    return newUser;
  },

  loginUser: async (email: string, passwordOrPin: string) => {
    const lockout = get().lockoutUntil;
    if (lockout && Date.now() < lockout) {
      const remainingSeconds = Math.ceil((lockout - Date.now()) / 1000);
      throw new Error(`Security Lockout: Too many failed attempts. Try again in ${remainingSeconds}s.`);
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await dbService.getUserByEmail(cleanEmail);
    
    if (!user) {
      const fails = get().failedAttempts + 1;
      const lockoutTime = fails >= 3 ? Date.now() + 30000 : null;
      set({ failedAttempts: fails, lockoutUntil: lockoutTime });
      return false;
    }

    const isPasswordValid = user.passwordHash && user.passwordSalt
      ? await verifySecret(passwordOrPin, user.passwordHash, user.passwordSalt)
      : false;

    const isPinValid = await verifySecret(passwordOrPin, user.pinHash, user.pinSalt);

    if (isPasswordValid || isPinValid) {
      localStorage.setItem('ticket_pos_session_user_id', user.id);
      set({
        activeUser: user,
        isAuthenticated: true,
        failedAttempts: 0,
        lockoutUntil: null,
      });
      return true;
    }

    // Rate-limiting calculation
    const fails = get().failedAttempts + 1;
    const lockoutTime = fails >= 3 ? Date.now() + 30000 : null;
    set({ failedAttempts: fails, lockoutUntil: lockoutTime });
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
    get().assertAdminRole();
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
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return true;
  },

  updatePasswordAfterRecovery: async (email: string, newPassword: string, newPin: string) => {
    const cleanEmail = email.trim().toLowerCase();

    // 1. Update Supabase Cloud password
    if (isSupabaseConfigured) {
      try {
        await updateSupabaseUserPassword(newPassword);
      } catch (e: any) {
        throw new Error(`Supabase password update failed: ${e.message}`);
      }
    }

    // 2. Generate new salted password and PIN hashes for local SQLite
    const passwordSalt = generateSalt();
    const passwordHash = await hashSecretWithSalt(newPassword, passwordSalt);

    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(newPin, pinSalt);

    // 3. Retrieve user profile (locally or self-heal by querying Supabase synced users profile)
    let user = await dbService.getUserByEmail(cleanEmail);

    if (!user && isSupabaseConfigured) {
      const { data: cloudUser } = await supabase
        .from('users')
        .select('*')
        .eq('email', cleanEmail)
        .maybeSingle();

      if (cloudUser) {
        user = {
          id: cloudUser.id,
          name: cloudUser.name || 'Admin',
          email: cleanEmail,
          username: cleanEmail,
          role: cloudUser.role || 'admin',
          createdAt: cloudUser.created_at || new Date().toISOString(),
          status: cloudUser.status || 'active',
          pinHash: '',
          pinSalt: '',
        };
      }
    }

    // Fallback: Rebuild from current active session metadata if still missing
    if (!user) {
      const sessionUser = (await supabase.auth.getUser()).data.user;
      user = {
        id: sessionUser?.id || crypto.randomUUID(),
        name: sessionUser?.user_metadata?.name || 'Admin',
        email: cleanEmail,
        username: cleanEmail,
        role: 'admin',
        createdAt: new Date().toISOString(),
        status: 'active',
        pinHash: '',
        pinSalt: '',
      };
    }

    const updatedUser: UserAccount = {
      ...user,
      passwordHash,
      passwordSalt,
      pinHash,
      pinSalt,
    };

    // Save or update locally depending on presence
    const localCheck = await dbService.getUserByEmail(cleanEmail);
    if (localCheck) {
      await dbService.updateUser(updatedUser);
    } else {
      await dbService.saveUser(updatedUser);
    }
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    set({
      activeUser: updatedUser,
      isAuthenticated: true,
      failedAttempts: 0,
      lockoutUntil: null,
    });

    await get().loadUsers();
    return true;
  },

  createStaffCashier: async (name: string, username: string, pin: string) => {
    get().assertAdminRole();
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
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return cashierUser;
  },

  resetCashierPin: async (cashierId: string, newPin: string) => {
    get().assertAdminRole();
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
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
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
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
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

  assertAdminRole: () => {
    const active = get().activeUser;
    if (!active || active.role !== 'admin') {
      throw new Error('Security Access Denied: Action requires an active Admin role');
    }
  },
}));
