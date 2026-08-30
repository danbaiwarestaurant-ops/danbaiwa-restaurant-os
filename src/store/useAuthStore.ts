import { create } from 'zustand';
import { UserAccount, UserRole } from '../types/user';
import { generateSalt, hashSecretWithSalt, verifySecret } from '../services/auth/pinAuth';
import { dbService } from '../services/db/IndexedDbService';
import { authenticateAdminWithSupabase, updateSupabaseUserPassword, deriveSupabasePassword, supabase, isSupabaseConfigured } from '../services/supabase/supabaseClient';
import { useDeviceStore } from './useDeviceStore';
import { useSyncStore } from './useSyncStore';
import { runCloudCatchUp, startRealtimeSync, stopRealtimeSync } from '../services/db/realtimeSync';
import {
  LoginFailure,
  LoginResult,
  buildLoginFailure,
  hasWebCrypto,
  isPinShaped,
} from '../services/auth/loginErrors';

const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_MS = 30_000;

/**
 * Registers a failed attempt and returns how many are left before the lockout kicks in,
 * so the message can say exactly where the user stands.
 */
function registerFailedAttempt(get: () => AuthState, set: (partial: Partial<AuthState>) => void): number {
  const fails = get().failedAttempts + 1;
  const lockoutUntil = fails >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_MS : null;
  set({ failedAttempts: fails, lockoutUntil });
  return Math.max(0, MAX_FAILED_ATTEMPTS - fails);
}

/**
 * Signing in on a machine that has never held this account.
 *
 * Without this the till is a dead end: a replacement machine has no local user row, so
 * the login is rejected outright and the cloud restore — which only ever runs *after* a
 * successful login — can never fire. The cloud is the authority on identity here, so we
 * authenticate against it first and let a successful sign-in pull the account down.
 */
async function adoptAccountFromCloud(
  cleanEmail: string,
  secret: string
): Promise<{ ok: true; user: UserAccount; authUserId: string; restored: boolean } | LoginFailure> {
  if (!isSupabaseConfigured) {
    return buildLoginFailure('unknown_account_local_only', { email: cleanEmail });
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return buildLoginFailure('unknown_account_offline', { email: cleanEmail });
  }

  // Deliberately NOT authenticateAdminWithSupabase(): that helper signs the user UP when
  // sign-in fails, which here would mint a brand-new cloud account out of a typo'd email.
  const { data, error } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password: deriveSupabasePassword(secret),
  });

  if (error || !data?.user) {
    const raw = (error?.message || '').toLowerCase();
    if (raw.includes('invalid login credentials') || raw.includes('invalid credentials')) {
      return buildLoginFailure('cloud_credentials_rejected', { email: cleanEmail });
    }
    if (raw.includes('email not confirmed') || raw.includes('email_not_confirmed')) {
      return buildLoginFailure('cloud_email_unconfirmed', { email: cleanEmail });
    }
    return buildLoginFailure('cloud_lookup_failed', {
      email: cleanEmail,
      detail: error?.message || 'no session returned',
    });
  }

  // Authenticated — pull this account's data down onto the machine.
  const restored = await runCloudCatchUp();
  let user = await dbService.getUserByEmail(cleanEmail);

  // Nothing came down (brand-new account, or the pull came up empty): fall back to the
  // synced users row directly, which RLS always lets an account read for itself
  // (id = auth.uid()).
  if (!user) {
    const { data: row } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (row?.pin_hash && row?.pin_salt) {
      user = {
        id: row.id,
        name: row.name || 'Admin',
        email: row.email || cleanEmail,
        username: row.username || cleanEmail,
        passwordHash: row.password_hash || undefined,
        passwordSalt: row.password_salt || undefined,
        pinHash: row.pin_hash,
        pinSalt: row.pin_salt,
        recoveryKeyHash: row.recovery_key_hash || undefined,
        recoveryKeySalt: row.recovery_key_salt || undefined,
        role: row.role || 'cashier',
        createdAt: row.created_at || new Date().toISOString(),
        status: row.status || 'active',
      };
      await dbService.saveUser(user);
    }
  }

  if (!user) {
    return buildLoginFailure('cloud_profile_missing', { email: cleanEmail });
  }

  return { ok: true, user, authUserId: data.user.id, restored };
}

interface AuthState {
  users: UserAccount[];
  activeUser: UserAccount | null;
  isAuthenticated: boolean;
  isLoaded: boolean;
  // True once at least one account has ever been created on this device — gates
  // public self-registration to true first-launch setup only.
  hasAnyUsers: boolean;

  // Rate-limiting & Brute-force protection
  failedAttempts: number;
  lockoutUntil: number | null; // Timestamp in ms

  isPinModalOpen: boolean;
  pinModalPurpose: string | null;
  pinChallengeCallback: ((success: boolean) => void) | null;

  loadUsers: () => Promise<void>;
  registerUser: (name: string, email: string, password: string, pin: string, role?: UserRole) => Promise<UserAccount>;
  loginUser: (email: string, passwordOrPin: string) => Promise<LoginResult>;
  logoutUser: () => Promise<void>;
  
  updateAdminProfile: (userId: string, name: string, email: string, newPin?: string) => Promise<boolean>;
  updatePasswordAfterRecovery: (email: string, newPassword: string, newPin: string) => Promise<boolean>;
  createStaffCashier: (name: string, username: string, pin: string) => Promise<UserAccount>;
  resetCashierPin: (cashierId: string, newPin: string) => Promise<boolean>;
  recoverAdminPinWithKey: (usernameOrEmail: string, recoveryKey: string, newPin: string) => Promise<boolean>;
  switchCashierSession: (userId: string, pin: string) => Promise<boolean>;
  
  /**
   * Re-establishes this browser's Supabase session from the admin PIN, without needing
   * a full log out / log back in. Needed because the cloud password is derived from the
   * PIN specifically (deriveSupabasePassword), so a password login — or any cashier
   * login — leaves the till with no cloud session and no way to get one back.
   */
  reconnectCloudSession: (pin: string) => Promise<{ ok: boolean; message?: string }>;

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
  hasAnyUsers: true,

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
      hasAnyUsers: users.length > 0,
    });

    // A resumed session (app reload while already logged in) is the most common way
    // this app is actually running most of the day — realtime sync needs to restart
    // here too, not just on a fresh interactive login. No-ops if this browser holds
    // no Supabase session (e.g. a cashier-only till that no admin has ever signed into).
    if (isAuthenticated) {
      startRealtimeSync();
      runCloudCatchUp().catch(() => {});
    }
  },

  registerUser: async (name: string, email: string, password: string, pin: string, role: UserRole = 'admin') => {
    // Public self-registration is only allowed for true first-launch setup — once
    // this device has any account at all, further accounts must be created by an
    // already-logged-in admin (see createStaffCashier).
    if (get().hasAnyUsers) {
      throw new Error('This till already has an account. Please log in, or ask an admin to create your account.');
    }

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
      hasAnyUsers: true,
      failedAttempts: 0,
      lockoutUntil: null,
    });

    await get().loadUsers();
    return newUser;
  },

  loginUser: async (email: string, passwordOrPin: string): Promise<LoginResult> => {
    const cleanEmail = email.trim().toLowerCase();

    // Every branch below returns one specific reason rather than a shared "invalid
    // details" — see services/auth/loginErrors.ts for the full vocabulary.
    if (!cleanEmail) return buildLoginFailure('missing_email');
    if (!passwordOrPin) return buildLoginFailure('missing_secret');

    const lockout = get().lockoutUntil;
    if (lockout && Date.now() < lockout) {
      return buildLoginFailure('locked_out', {
        retryAfterSeconds: Math.ceil((lockout - Date.now()) / 1000),
      });
    }

    // Served over plain http:// on a LAN address, crypto.subtle is simply absent and
    // every hash comparison throws — which used to surface as "login failed".
    if (!hasWebCrypto()) return buildLoginFailure('crypto_unavailable');

    const user = await dbService.getUserByEmail(cleanEmail);

    // Account unknown to this machine — try to bring it down from the cloud instead of
    // pretending the credentials were wrong.
    if (!user) {
      const adopted = await adoptAccountFromCloud(cleanEmail, passwordOrPin);
      if (!adopted.ok) {
        // Only a rejected credential counts toward the lockout; being offline or
        // hitting an unconfigured cloud is not a guessing attempt.
        if (adopted.code === 'cloud_credentials_rejected') {
          const attemptsRemaining = registerFailedAttempt(get, set);
          return { ...adopted, attemptsRemaining };
        }
        return adopted;
      }

      if (adopted.user.status !== 'active') {
        return buildLoginFailure('account_disabled', { email: cleanEmail });
      }

      // The cloud already authenticated this exact identity, so no second local check is
      // needed when the restored profile is that same account. If the ids differ, the
      // snapshot's record is a different person — fall back to verifying the secret.
      if (adopted.user.id !== adopted.authUserId) {
        const matches =
          (await verifySecret(passwordOrPin, adopted.user.pinHash, adopted.user.pinSalt)) ||
          (adopted.user.passwordHash && adopted.user.passwordSalt
            ? await verifySecret(passwordOrPin, adopted.user.passwordHash, adopted.user.passwordSalt)
            : false);

        if (!matches) {
          const attemptsRemaining = registerFailedAttempt(get, set);
          return buildLoginFailure(isPinShaped(passwordOrPin) ? 'wrong_pin' : 'wrong_password', {
            email: cleanEmail,
            attemptsRemaining,
          });
        }
      }

      localStorage.setItem('ticket_pos_session_user_id', adopted.user.id);
      set({
        activeUser: adopted.user,
        isAuthenticated: true,
        failedAttempts: 0,
        lockoutUntil: null,
      });
      startRealtimeSync();
      await get().loadUsers();
      await useSyncStore.getState().checkOutbox();
      return { ok: true, restoredFromCloud: adopted.restored };
    }

    if (user.status !== 'active') {
      return buildLoginFailure('account_disabled', { email: cleanEmail });
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

      // Reuses whatever Supabase session this browser already holds (e.g. from a
      // prior admin login) — the gate inside checks the actual session, not which
      // local role just signed in, so this safely no-ops on a cashier-only till.
      startRealtimeSync();
      runCloudCatchUp().catch(() => {});

      // Logging out destroys the cloud (Supabase) session, and day-to-day PIN login
      // never re-establishes one — silently leaving cloud sync (and cross-device
      // sync) permanently broken after the very first logout. Re-authenticate to the
      // cloud in the background whenever we can (admin + verified via PIN, since
      // that's the same secret their cloud account password is derived from). Never
      // let this block or fail the actual local login — this is best-effort healing.
      if (isSupabaseConfigured && user.role === 'admin' && isPinValid) {
        const locationId = useDeviceStore.getState().config.locationId || 'LOC01';
        authenticateAdminWithSupabase(cleanEmail, passwordOrPin, locationId)
          .then(async () => {
            startRealtimeSync();
            const changed = await runCloudCatchUp();
            if (changed) {
              await get().loadUsers();
              await useSyncStore.getState().checkOutbox();
            }
          })
          .catch((e) => {
            console.warn('[Auth] Background cloud session refresh failed (will retry next login):', e);
            // Don't leave the reason console-only — the badge turns red and the reconnect
            // dialog needs something better than "it didn't work" to show the operator.
            useSyncStore.setState({
              cloudConnected: false,
              cloudError: e?.message || 'Cloud sign-in failed during login.',
            });
          });
      } else if (isSupabaseConfigured && !isPinValid) {
        // Signed in with the account password (or as a cashier). The Supabase password is
        // derived from the PIN, which we can't recover from a password login, so this till
        // has no cloud session — say so plainly instead of letting it look connected.
        useSyncStore.setState({
          cloudConnected: false,
          cloudError:
            user.role === 'admin'
              ? 'Signed in with the account password, which cannot unlock cloud sync — the cloud credential is derived from your PIN. Reconnect below with your admin PIN.'
              : 'Cashier accounts have no cloud identity of their own, so this till is not connected to the cloud. Work is queued safely; an admin PIN will send it.',
        });
      }
      return { ok: true };
    }

    // The account exists here and is active, so the only thing left that can be wrong is
    // the secret itself — name which one they typed rather than listing all three.
    const attemptsRemaining = registerFailedAttempt(get, set);
    return buildLoginFailure(isPinShaped(passwordOrPin) ? 'wrong_pin' : 'wrong_password', {
      email: cleanEmail,
      attemptsRemaining,
    });
  },

  reconnectCloudSession: async (pin: string) => {
    const user = get().activeUser;

    if (!user) {
      return { ok: false, message: 'No one is signed in on this till.' };
    }
    if (!isSupabaseConfigured) {
      return {
        ok: false,
        message: 'This build has no Supabase credentials configured, so there is no cloud to connect to.',
      };
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return {
        ok: false,
        message: 'This device is offline. Your work stays queued — reconnect once the internet is back.',
      };
    }

    // The cloud identity belongs to the admin account. A cashier PIN can't unlock it,
    // and saying so is more useful than a generic failure.
    const admin =
      user.role === 'admin' ? user : get().users.find((u) => u.role === 'admin' && u.status === 'active');

    if (!admin) {
      return {
        ok: false,
        message: 'Only the admin account can reconnect this till to the cloud, and no admin account exists on this device.',
      };
    }

    const pinMatches = await verifySecret(pin, admin.pinHash, admin.pinSalt);
    if (!pinMatches) {
      return { ok: false, message: `That PIN does not match the admin account (${admin.email}).` };
    }

    try {
      const locationId = useDeviceStore.getState().config.locationId || 'LOC01';
      await authenticateAdminWithSupabase(admin.email, pin, locationId);

      useSyncStore.setState({ cloudConnected: true, cloudError: null });
      startRealtimeSync();
      await runCloudCatchUp();
      await get().loadUsers();
      await useSyncStore.getState().checkOutbox();
      await useSyncStore.getState().triggerSyncWorker();

      return { ok: true };
    } catch (e: any) {
      // Surfaced verbatim in the reconnect dialog. The common case is an admin whose PIN
      // was changed locally while the cloud password stayed derived from the old one —
      // the raw Supabase message ("Invalid login credentials") is the clue for that.
      const message = e?.message || 'Cloud sign-in failed for an unknown reason.';
      useSyncStore.setState({ cloudConnected: false, cloudError: message });
      return { ok: false, message };
    }
  },

  logoutUser: async () => {
    stopRealtimeSync();

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

    // The cloud password is derived from the PIN, so changing the PIN locally without
    // updating it in Supabase would silently break cloud sign-in (and therefore sync
    // and backups) on the next login.
    if (newPin && newPin.length >= 4 && isSupabaseConfigured && user.role === 'admin') {
      try {
        await updateSupabaseUserPassword(deriveSupabasePassword(newPin));
      } catch (e: any) {
        throw new Error(
          `PIN not changed: the cloud account could not be updated (${e.message}). ` +
          `Check your internet connection and try again.`
        );
      }
    }

    await dbService.updateUser(updatedUser);
    set({ activeUser: updatedUser });
    await get().loadUsers();
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return true;
  },

  updatePasswordAfterRecovery: async (email: string, newPassword: string, newPin: string) => {
    let cleanEmail = email.trim().toLowerCase();

    // 1. Update Supabase Cloud password. The recovery target MUST be derived from the
    // authenticated recovery session itself, never from the (user-editable) email field
    // the caller passes in — otherwise anyone with a valid recovery link for their own
    // account could type in a different email and hijack that account's local login.
    if (isSupabaseConfigured) {
      const sessionUser = (await supabase.auth.getUser()).data.user;
      if (!sessionUser?.email) {
        throw new Error('No authenticated recovery session found. Please use the reset link from your email again.');
      }
      cleanEmail = sessionUser.email.trim().toLowerCase();

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
          role: cloudUser.role || 'cashier',
          createdAt: cloudUser.created_at || new Date().toISOString(),
          status: cloudUser.status || 'active',
          pinHash: '',
          pinSalt: '',
        };
      }
    }

    // No local or cloud profile exists for this authenticated identity — refuse to
    // fabricate one rather than minting an unverified admin account from nothing.
    if (!user) {
      throw new Error(`No account profile found for "${cleanEmail}". Please contact an administrator.`);
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
