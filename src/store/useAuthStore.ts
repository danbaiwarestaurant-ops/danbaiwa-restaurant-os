import { create } from 'zustand';
import { UserAccount, UserRole, UserStatus } from '../types/user';
import { generateSalt, hashSecretWithSalt, verifySecret } from '../services/auth/pinAuth';
import { dbService } from '../services/db/IndexedDbService';
import {
  authenticateAdminWithSupabase,
  updateSupabaseUserPassword,
  deriveSupabasePassword,
  signUpNewAdminAccount,
  supabase,
  isSupabaseConfigured,
} from '../services/supabase/supabaseClient';
import { useDeviceStore } from './useDeviceStore';
import { useSyncStore } from './useSyncStore';
import { runCloudCatchUp, startRealtimeSync, stopRealtimeSync } from '../services/db/realtimeSync';
import {
  ensureDeviceEnrolled,
  restoreDeviceSession,
  clearDeviceIdentity,
  reportDeviceSeen,
  isTillSession,
} from '../services/supabase/deviceIdentity';
import { getAccountId } from '../services/db/accountScope';
import { generateRecoveryKey, normaliseRecoveryKey } from '../utils/recoveryKey';
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
  // A staff ID ("amina", "till-2") is not an email, so there is nothing to sign in to the
  // cloud with — cashiers hold no cloud identity of their own. Say that plainly, rather
  // than letting Supabase answer "Unable to validate email address" and reporting it as a
  // rejected credential, which is what made a fresh browser profile look like it was
  // disputing a perfectly good login.
  if (!cleanEmail.includes('@')) {
    return buildLoginFailure('unknown_account_needs_admin', { email: cleanEmail });
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return buildLoginFailure('unknown_account_offline', { email: cleanEmail });
  }

  // Deliberately NOT authenticateAdminWithSupabase(): that helper signs the user UP when
  // sign-in fails, which here would mint a brand-new cloud account out of a typo'd email.
  //
  // Two passwords are tried because a machine that has never held this account has no way
  // to tell which secret the operator typed. The cloud password is normally derived from
  // the till PIN, but an account whose password was reset from the Supabase dashboard (or
  // set directly by an older build) carries the typed secret verbatim — and that account
  // could previously never be adopted onto a new machine at all.
  let data: any = null;
  let error: any = null;
  // The cloud password is normally derive(PIN). When it is the raw secret instead, the
  // two are out of step, and anything that later re-derives the password from the PIN
  // will fail — so the caller has to be told rather than left to discover it.
  let secretIsThePin = true;

  for (const password of [deriveSupabasePassword(secret), secret]) {
    const attempt = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
    if (!attempt.error && attempt.data?.user) {
      data = attempt.data;
      error = null;
      secretIsThePin = password !== secret;
      break;
    }
    error = attempt.error;
    // Only a rejected password is worth a second guess. "Email not confirmed", rate limits
    // and network failures answer identically whichever password we send, so retrying just
    // burns another attempt against the provider.
    const why = (attempt.error?.message || '').toLowerCase();
    if (!why.includes('invalid login credentials') && !why.includes('invalid credentials')) break;
  }

  if (!data?.user) {
    const raw = (error?.message || '').toLowerCase();
    if (raw.includes('invalid login credentials') || raw.includes('invalid credentials')) {
      // Which secret they typed is the whole difference between "try again" and "you cannot
      // get in from here": the account password is only ever checked against this machine's
      // local copy, so on a machine without one, only the PIN can possibly work.
      return buildLoginFailure(
        isPinShaped(secret) ? 'cloud_credentials_rejected' : 'cloud_needs_admin_pin',
        { email: cleanEmail, detail: error?.message }
      );
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
  const restored = await runCloudCatchUp({ revive: true });
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

  // The cloud has confirmed this is the account owner, but no POS profile has ever
  // reached it — most often because the email was never confirmed, so the till that
  // registered the account never held a session to upload one through. Stopping here
  // was the end of the road: the owner was locked out of every machine except the one
  // they registered on, with no route back that did not involve a developer.
  //
  // Signing in to the auth account is the same proof registration itself stood on, so
  // rebuild the profile from it rather than refuse.
  if (!user) {
    // A till's own credential is not a person's. Nobody types a till's generated
    // address, but if one ever reached here it must not mint itself an admin.
    if (isTillSession(data.session) || isTillSession({ user: data.user })) {
      return buildLoginFailure('cloud_profile_missing', { email: cleanEmail });
    }

    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(secret, pinSalt);
    const metadata = (data.user.user_metadata || {}) as Record<string, any>;

    user = {
      id: data.user.id,
      name: metadata.name || metadata.full_name || cleanEmail.split('@')[0] || 'Admin',
      email: cleanEmail,
      username: cleanEmail,
      pinHash,
      pinSalt,
      role: 'admin',
      createdAt: data.user.created_at || new Date().toISOString(),
      status: 'active',
      accountId: data.user.id,
      // Dated to the account's creation, not to now, so that when the genuine profile
      // does arrive from the original till it wins the last-write-wins merge and
      // replaces this reconstruction — bringing back the real name, the password hash
      // and the recovery key, none of which can be rebuilt from a sign-in.
      updatedAt: data.user.created_at || new Date(0).toISOString(),
    };

    // Local only, deliberately: this row shares a primary key with the real profile
    // still sitting on the original till, and uploading a reconstruction would
    // overwrite it the moment that till came online.
    await dbService.saveUserLocalOnly(user, true);
    console.info('[Auth] No profile in the cloud for this account yet — rebuilt one on this device from the verified cloud sign-in.');

    if (!secretIsThePin) {
      useSyncStore.setState({
        cloudError:
          'Signed in with the account password rather than the till PIN, so this device\'s ' +
          'PIN and its cloud password are out of step. Set a new PIN from the admin profile ' +
          'screen to bring them back in line.',
      });
    }
  }

  return { ok: true, user, authUserId: data.user.id, restored };
}

/**
 * Outcome of a staff-roster action.
 *
 * These fail for ordinary, explainable reasons — a name already taken, an account that
 * still owns records — and the admin needs to be told which. A bare boolean would leave
 * the UI guessing, so every refusal carries the reason it refused.
 */
export interface StaffActionResult {
  ok: boolean;
  message?: string;
}

export interface StaffRecordCounts {
  tickets: number;
  shifts: number;
  expenses: number;
  auditLogs: number;
  total: number;
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
  /**
   * Whose PIN opens this particular challenge.
   *
   * 'admin' — an authority check: manager mode, voiding a ticket, approving an expense.
   *           Only an active admin's PIN will do.
   * 'session' — merely proving the same person is still standing there, for the screen
   *           lock. The signed-in user's own PIN works, and an admin's always does too so
   *           a manager can take over a till someone walked away from.
   *
   * Without the distinction, locking the screen was an admin-only door: a cashier working
   * alone who locked the till — or simply let the five-minute idle timer fire — could not
   * get back into it without fetching the owner.
   */
  pinModalScope: 'admin' | 'session' | 'cashier';

  /**
   * True while an admin PIN has unlocked the manager console.
   *
   * The console is admin territory regardless of which cashier happens to be signed in at
   * the till — entering it already requires the admin PIN, and `validatePin` accepts admin
   * PINs only. Without this, a cashier who unlocked the console with the owner's PIN could
   * read every panel but not create staff or reset a PIN, because those checked the
   * *signed-in role* rather than the authority that was actually proven at the door.
   *
   * Granted only by the console gate and revoked on leaving it, on cashier switch, and on
   * logout — never by the PIN prompts used for voids or expense approvals, which prove
   * authority for that single action and nothing more.
   */
  hasAdminAuthority: boolean;
  grantAdminAuthority: () => void;
  revokeAdminAuthority: () => void;

  loadUsers: () => Promise<void>;
  registerUser: (name: string, email: string, password: string, pin: string, role?: UserRole) => Promise<UserAccount>;
  loginUser: (email: string, passwordOrPin: string) => Promise<LoginResult>;
  /**
   * End the staff session at the till.
   *
   * `unenrolDevice` also signs the device out of the cloud, which is a much bigger act
   * than it sounds: the Supabase credential is derived from the admin PIN, so once it is
   * gone nothing syncs until an admin comes and types that PIN in. That used to happen on
   * every ordinary logout, which is why tills kept ending up stranded on "Not Signed In
   * to Cloud" with a queue nobody at the counter could clear. Who is standing at the till
   * and whether the device is enrolled to the account are different questions; only the
   * console's explicit "System Logout" answers the second one.
   */
  logoutUser: (options?: { unenrolDevice?: boolean }) => Promise<void>;

  updateAdminProfile: (userId: string, name: string, email: string, newPin?: string) => Promise<boolean>;
  updatePasswordAfterRecovery: (email: string, newPassword: string, newPin: string) => Promise<boolean>;
  createStaffCashier: (name: string, username: string, pin: string) => Promise<UserAccount>;
  resetCashierPin: (cashierId: string, newPin: string) => Promise<boolean>;

  /** Rename a staff account or change its login username. */
  updateStaffMember: (userId: string, name: string, username: string) => Promise<StaffActionResult>;
  /**
   * Switch a staff account between active and deactivated. Deactivating blocks sign-in
   * while keeping every record they created intact — the reversible counterpart to
   * deleteStaffMember, and what should be reached for in almost every case.
   */
  setStaffStatus: (userId: string, status: UserStatus) => Promise<StaffActionResult>;
  /** How much history an account owns; zero everywhere is what makes deletion safe. */
  countStaffRecords: (userId: string) => Promise<StaffRecordCounts>;
  /** Permanently remove a staff account. Refuses if it owns any record. */
  deleteStaffMember: (userId: string) => Promise<StaffActionResult>;
  /**
   * Reset the admin PIN offline using the master recovery key.
   *
   * `cloudRealigned` is false whenever the reset happened without a cloud session: the
   * Supabase password is derived from the PIN, so a PIN changed offline no longer matches
   * it and sync stays down until the emailed password reset is run. Reported rather than
   * hidden — a till that silently stops syncing is the failure this whole area exists to
   * avoid.
   */
  recoverAdminPinWithKey: (
    usernameOrEmail: string,
    recoveryKey: string,
    newPin: string
  ) => Promise<{ ok: boolean; message?: string; cloudRealigned?: boolean }>;

  /**
   * The freshly issued recovery key, held in memory for the one screen that shows it.
   *
   * Only its hash is stored, so this is the only moment it can ever be read. Cleared by
   * acknowledgeRecoveryKey once the admin confirms they have written it down.
   */
  pendingRecoveryKey: string | null;
  acknowledgeRecoveryKey: () => void;
  /**
   * Issue a new master recovery key for the admin, replacing any previous one. Gated by
   * the current admin PIN, since holding the key is equivalent to knowing the PIN.
   */
  regenerateRecoveryKey: (pin: string) => Promise<{ ok: boolean; key?: string; message?: string }>;

  /**
   * There is deliberately no "switch cashier" action any more.
   *
   * A shift now opens at sign-in and closes at sign-out, so swapping the person at the
   * till without passing through both is what would leave one cashier's takings sitting
   * inside another's shift. Handing over is: log out (count the drawer), log in.
   */

  /**
   * Re-establishes this browser's Supabase session from the admin PIN, without needing
   * a full log out / log back in. Needed because the cloud password is derived from the
   * PIN specifically (deriveSupabasePassword), so a password login — or any cashier
   * login — leaves the till with no cloud session and no way to get one back.
   */
  reconnectCloudSession: (pin: string) => Promise<{ ok: boolean; message?: string }>;

  openPinModal: (
    purpose: string,
    onVerify: (success: boolean) => void,
    scope?: 'admin' | 'session' | 'cashier'
  ) => void;
  closePinModal: () => void;
  validatePin: (pin: string) => Promise<boolean>;
  assertAdminRole: () => void;
}

/**
 * Enrol this till with the account, in the background, whenever an owner session is live.
 *
 * Deliberately fire-and-forget: enrolment is a convenience for *later* (it is what lets
 * the till restore its own cloud session with nobody present), never a precondition for
 * the sign-in happening right now. A till that fails to enrol — offline, sign-ups
 * disabled, whatever — simply carries on using the owner's session and tries again next
 * time an owner signs in.
 */
function enrolThisTill(): void {
  if (!isSupabaseConfigured) return;
  const config = useDeviceStore.getState().config;
  ensureDeviceEnrolled({
    deviceId: config.deviceId,
    locationId: config.locationId,
    label: [config.locationId, config.deviceId].filter(Boolean).join('-') || undefined,
  }).catch((e) => console.warn('[Auth] till enrolment skipped:', e));
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
  pinModalScope: 'admin',

  hasAdminAuthority: false,
  grantAdminAuthority: () => set({ hasAdminAuthority: true }),
  revokeAdminAuthority: () => set({ hasAdminAuthority: false }),

  pendingRecoveryKey: null,
  acknowledgeRecoveryKey: () => set({ pendingRecoveryKey: null }),

  regenerateRecoveryKey: async (pin: string) => {
    const admin = get().users.find((u) => u.role === 'admin' && u.status === 'active');
    if (!admin) return { ok: false, message: 'No active admin account on this device.' };

    const pinOk = await verifySecret(pin, admin.pinHash, admin.pinSalt);
    if (!pinOk) return { ok: false, message: 'That is not the current admin PIN.' };

    const key = generateRecoveryKey();
    const recoveryKeySalt = generateSalt();
    const recoveryKeyHash = await hashSecretWithSalt(normaliseRecoveryKey(key), recoveryKeySalt);

    await dbService.updateUser({ ...admin, recoveryKeyHash, recoveryKeySalt });
    await get().loadUsers();
    set({ pendingRecoveryKey: key });
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return { ok: true, key };
  },

  loadUsers: async () => {
    await dbService.init();
    const allUsers = await dbService.getUsers();

    // A browser profile can end up holding more than one business's roster — a till
    // that was repurposed, a back-office machine an owner and a franchisee both used.
    // Showing all of them together is not merely untidy: staff IDs are only unique
    // within one restaurant, so two "amina" rows would compete for the same login.
    // Scope the roster to the account whose session this browser actually holds.
    //
    // Rows with no accountId are kept: they predate account stamping and belong to
    // whoever is on this device. And if the scoping would empty the roster (no session
    // yet, or nothing stamped), fall back to everything rather than lock the till out.
    // Bounded, because this is the boot path: the whole app sits behind a spinner until
    // loadUsers resolves, and resolving the account can touch the network (a session
    // whose token needs refreshing). A slow or captive connection must cost the till a
    // moment of unscoped roster, never a screen that never arrives.
    const scopeAccountId = await Promise.race([
      getAccountId(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    const scoped = scopeAccountId
      ? allUsers.filter((u) => !u.accountId || u.accountId === scopeAccountId)
      : allUsers;
    const users = scoped.length ? scoped : allUsers;
    
    const savedUserId = localStorage.getItem('ticket_pos_session_user_id');
    let activeUser: UserAccount | null = null;
    let isAuthenticated = false;

    if (savedUserId) {
      activeUser = users.find(u => u.id === savedUserId && u.status === 'active') || null;
      if (activeUser) isAuthenticated = true;
    }

    set({
      // Every account, deactivated ones included. They have to stay visible: the roster is
      // where an admin reactivates someone, and a deactivated cashier's past tickets must
      // still resolve to their name rather than reading "Unknown cashier" for ever.
      // Anywhere that must not *offer* a disabled account filters on status itself —
      // loginUser and validatePin.
      users,
      activeUser,
      isAuthenticated,
      isLoaded: true,
      // Deliberately every local account, not the scoped roster. This gates public
      // self-registration, and a browser profile that already holds somebody's
      // business is not a first launch however little of it belongs to this account.
      hasAnyUsers: allUsers.length > 0,
    });

    // A resumed session (app reload while already logged in) is the most common way
    // this app is actually running most of the day — realtime sync needs to restart
    // here too, not just on a fresh interactive login.
    //
    // Boot is also where an enrolled till signs *itself* back into the cloud. Without it
    // a till that had been logged out, cleared, or left offline long enough to lose its
    // token came up cloud-less and stayed that way until an owner arrived with a PIN,
    // which is precisely what running the business remotely cannot depend on.
    if (isAuthenticated) {
      (async () => {
        const restored = await restoreDeviceSession().catch(() => false);
        // An owner session that predates device identity (or one whose enrolment was
        // revoked and then re-established by a PIN sign-in) still needs enrolling once.
        enrolThisTill();
        if (restored) void reportDeviceSeen();
        startRealtimeSync();
        runCloudCatchUp({ revive: true }).catch(() => {});
      })();
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

    // 2. Create the cloud account — which is also the only duplicate check that works.
    //
    // What used to be here was a `select('id').eq('email', ...)` probe against the users
    // table. It can never find anything: the query runs on the anon key with no session,
    // and every RLS policy on that table is granted TO authenticated, so it comes back
    // empty for an email that is very much registered. authenticateAdminWithSupabase then
    // signed the caller IN to the existing account and reported it as a fresh signup. On a
    // browser profile that had never held the account, "Create Account" therefore sailed
    // through and re-registered a live business — writing new PIN, password and recovery
    // key hashes over the real ones and syncing them up. Only Supabase Auth can answer
    // "does this email already exist", so ask it, and treat yes as a refusal.
    const locationId = useDeviceStore.getState().config.locationId || 'LOC01';
    const signUp = await signUpNewAdminAccount(cleanEmail, pin, locationId);

    if (!signUp.ok) {
      // The reason travels with the error so the form can send them to the login tab
      // rather than leave them re-typing a registration that can never succeed.
      const failure: any = new Error(signUp.message);
      failure.code = signUp.reason;
      throw failure;
    }

    const supabaseAuthResult = { userId: signUp.userId };

    // A sign-up with no session means the project requires email confirmation. That is
    // not a detail: until the link in that inbox is clicked, this browser holds no
    // cloud session, so the account's own users row (PIN and password hashes included)
    // can never be pushed, and every other device is told "Email not confirmed" when it
    // tries to sign in. The till works perfectly here and nowhere else — which is
    // exactly how an account comes to be unusable on the machine it was not created on.
    if (isSupabaseConfigured && !signUp.session) {
      useSyncStore.setState({
        cloudConnected: false,
        cloudError:
          `Confirm the email sent to ${cleanEmail} before using this account anywhere else. ` +
          'Until then this till cannot reach the cloud, nothing syncs, and signing in on ' +
          'another device or browser will be refused. (An admin can also confirm it from ' +
          'the Supabase dashboard under Authentication > Users.)',
      });
    }

    // The owner's session is live for the first and only time on a brand-new till, which
    // is the moment to give the device an identity of its own.
    enrolThisTill();

    // 3. Generate per-user cryptographic salts
    const passwordSalt = generateSalt();
    const passwordHash = await hashSecretWithSalt(password, passwordSalt);

    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(pin, pinSalt);

    // The offline break-glass key. This was never issued before — recoverAdminPinWithKey
    // checked for a recoveryKeyHash that nothing ever wrote, so the "Forgot Admin PIN?"
    // route advertised on the PIN pad could not succeed for any account ever created.
    const recoveryKey = generateRecoveryKey();
    const recoveryKeySalt = generateSalt();
    const recoveryKeyHash = await hashSecretWithSalt(normaliseRecoveryKey(recoveryKey), recoveryKeySalt);

    const newUser: UserAccount = {
      id: supabaseAuthResult.userId || crypto.randomUUID(),
      name: name.trim(),
      email: cleanEmail,
      username: cleanEmail,
      passwordHash,
      passwordSalt,
      pinHash,
      pinSalt,
      recoveryKeyHash,
      recoveryKeySalt,
      role,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    await dbService.saveUser(newUser);
    // Held for the one screen that can ever show it; only the hash was stored.
    set({ pendingRecoveryKey: recoveryKey });
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

    // Which business this till is working for. Emails are unique everywhere, so this
    // changes nothing for an admin sign-in; it is what keeps one shop's "amina" out of
    // another shop's till when both rosters have synced into the same browser profile.
    const scopeAccountId = await getAccountId();
    const candidates = await dbService.findUsersByLoginKey(cleanEmail);
    const user =
      candidates.length > 1
        ? await dbService.getUserByEmail(cleanEmail, scopeAccountId)
        : candidates[0] ?? null;

    // Two businesses here, and nothing says which one is meant. Guessing would hand a
    // cashier a session on somebody else's takings, so refuse and say how to settle it.
    if (!user && candidates.length > 1) {
      return buildLoginFailure('ambiguous_login_key', { email: cleanEmail });
    }

    // Account unknown to this machine — try to bring it down from the cloud instead of
    // pretending the credentials were wrong.
    if (!user) {
      const adopted = await adoptAccountFromCloud(cleanEmail, passwordOrPin);
      if (!adopted.ok) {
        // Only a rejected credential counts toward the lockout; being offline or
        // hitting an unconfigured cloud is not a guessing attempt.
        if (
          adopted.code === 'cloud_credentials_rejected' ||
          adopted.code === 'cloud_needs_admin_pin'
        ) {
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
      runCloudCatchUp({ revive: true }).catch(() => {});

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
            enrolThisTill();
            startRealtimeSync();
            const changed = await runCloudCatchUp({ revive: true });
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

    // This device's copy of the account said no. That is not the last word, because the
    // copy can be out of date or simply wrong: a PIN changed on another till that has
    // not reached here yet, or a profile written by the old "Create Account" bug, which
    // let a second browser re-register a live email and overwrite its hashes. In that
    // state the correct, current credentials are refused for ever — and the cloud, which
    // knows better, is never asked, because a local row exists.
    //
    // Only for accounts that hold a cloud identity of their own (an email). A cashier's
    // staff ID has nothing to authenticate against, so nothing is gained by trying.
    if (cleanEmail.includes('@') && isSupabaseConfigured && navigator.onLine !== false) {
      const verified = await adoptAccountFromCloud(cleanEmail, passwordOrPin);

      if (verified.ok) {
        // The cloud accepted what this device rejected, so the stored hash is the thing
        // that is wrong. Correct it, or the next sign-in — offline, with no cloud to
        // appeal to — is refused all over again. Local only: the cloud's row is the
        // authority here and has nothing to learn from us.
        const stillWrong = !(await verifySecret(
          passwordOrPin,
          verified.user.pinHash,
          verified.user.pinSalt
        ));

        if (stillWrong) {
          const salt = generateSalt();
          const hash = await hashSecretWithSalt(passwordOrPin, salt);
          // Repair the secret they actually typed. Writing a password into pinHash would
          // put the till's PIN and its cloud password (derived from the PIN) out of step.
          const healed: UserAccount = isPinShaped(passwordOrPin)
            ? { ...verified.user, pinHash: hash, pinSalt: salt }
            : { ...verified.user, passwordHash: hash, passwordSalt: salt };
          await dbService.saveUserLocalOnly(healed);
          verified.user = healed;
          console.info('[Auth] Local credentials were stale; repaired from the verified cloud sign-in.');
        }

        localStorage.setItem('ticket_pos_session_user_id', verified.user.id);
        set({
          activeUser: verified.user,
          isAuthenticated: true,
          failedAttempts: 0,
          lockoutUntil: null,
        });
        startRealtimeSync();
        enrolThisTill();
        await get().loadUsers();
        await useSyncStore.getState().checkOutbox();
        return { ok: true, restoredFromCloud: verified.restored };
      }
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

      // Re-enrol a till whose access was revoked, or that never got an identity, so this
      // is the last time anyone has to type a PIN to get it syncing again.
      enrolThisTill();

      useSyncStore.setState({ cloudConnected: true, cloudError: null });
      startRealtimeSync();
      await runCloudCatchUp({ revive: true });
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

  logoutUser: async ({ unenrolDevice = false } = {}) => {
    if (unenrolDevice) {
      stopRealtimeSync();
      // The device's own credential goes too, or boot would simply sign the till back in
      // and "disconnect this device" would be a button that does nothing.
      await clearDeviceIdentity().catch(() => {});
      try {
        if (navigator.onLine && supabase) {
          await supabase.auth.signOut();
        }
      } catch (e) {}
      useSyncStore.setState({
        cloudConnected: false,
        cloudError:
          'This device was signed out of the cloud. Anything still queued stays safe here — sign in with the admin PIN to send it.',
      });
    }
    // Otherwise the device stays enrolled: realtime sync keeps running and the outbox
    // keeps draining, so whatever the last shift recorded reaches the cloud even though
    // nobody is signed in at the counter. The local data was already on this device
    // either way, and the session's reach is exactly the account it belongs to — so
    // holding it grants nothing the machine did not already have.

    localStorage.removeItem('ticket_pos_session_user_id');
    set({
      activeUser: null,
      isAuthenticated: false,
      hasAdminAuthority: false,
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
        // The cloud password is *always* derived from the PIN — every sign-in path
        // (authenticateAdminWithSupabase, reconnectCloudSession) computes it that way.
        // This used to set it to the typed password instead, which meant completing an
        // email recovery left the cloud password and the PIN permanently out of step:
        // the local login worked, and the till could never establish a cloud session
        // again. The typed password stays the local login secret, hashed below.
        await updateSupabaseUserPassword(deriveSupabasePassword(newPin));
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
    // Cashiers hold no cloud identity of their own — they belong to the admin's account,
    // which is what makes them appear on every device that admin signs in on.
    const accountId = await getAccountId();

    // updateStaffMember has always refused a duplicate staff ID; creating one never
    // checked at all, so the roster could be given two people answering to the same
    // login and one of them would simply become unreachable. Scoped to this account:
    // another restaurant's "amina" is a different person and no business of ours.
    const cleanUsername = username.trim().toLowerCase();
    const clash = get().users.find(
      (u) =>
        (u.username || '').toLowerCase() === cleanUsername &&
        (!accountId || !u.accountId || u.accountId === accountId)
    );
    if (clash) {
      throw new Error(`The staff ID "${cleanUsername}" is already used by ${clash.name}.`);
    }
    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(pin, pinSalt);
    const passwordSalt = generateSalt();
    const passwordHash = await hashSecretWithSalt(pin, passwordSalt);

    const cashierUser: UserAccount = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: cleanUsername,
      username: cleanUsername,
      passwordHash,
      passwordSalt,
      pinHash,
      pinSalt,
      role: 'cashier',
      createdAt: new Date().toISOString(),
      status: 'active',
      accountId: accountId ?? undefined,
    };

    await dbService.saveUser(cashierUser);
    await get().loadUsers();
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return cashierUser;
  },

  updateStaffMember: async (userId: string, name: string, username: string) => {
    get().assertAdminRole();
    const user = get().users.find(u => u.id === userId);
    if (!user) return { ok: false, message: 'That staff account no longer exists.' };

    const cleanName = name.trim();
    const cleanUsername = username.trim().toLowerCase();
    if (!cleanName) return { ok: false, message: 'A name is required.' };
    if (!cleanUsername) return { ok: false, message: 'A staff ID is required.' };

    // The username is a login key, so a collision would make one of the two accounts
    // unreachable — caught here rather than left to fail obscurely at the next sign-in.
    const clash = get().users.find(
      (u) =>
        u.id !== userId &&
        (u.username || '').toLowerCase() === cleanUsername &&
        (!user.accountId || !u.accountId || u.accountId === user.accountId)
    );
    if (clash) {
      return { ok: false, message: `The staff ID "${cleanUsername}" is already used by ${clash.name}.` };
    }

    await dbService.updateUser({
      ...user,
      name: cleanName,
      username: cleanUsername,
      // An admin's email is their cloud identity and is changed through the profile
      // screen, which also updates Supabase. Only a cashier's email tracks the username.
      email: user.role === 'admin' ? user.email : cleanUsername,
    });
    await get().loadUsers();
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return { ok: true };
  },

  setStaffStatus: async (userId: string, status: UserStatus) => {
    get().assertAdminRole();
    const user = get().users.find(u => u.id === userId);
    if (!user) return { ok: false, message: 'That staff account no longer exists.' };
    if (user.status === status) return { ok: true };

    if (status === 'deactivated') {
      // Locking out the only admin would leave the account with no way back in: manager
      // mode, staff management and the cloud sign-in all key off an active admin PIN.
      if (user.role === 'admin') {
        const otherAdmins = get().users.filter(
          (u) => u.id !== userId && u.role === 'admin' && u.status === 'active'
        );
        if (otherAdmins.length === 0) {
          return { ok: false, message: 'This is the only admin account. Deactivating it would lock everyone out of the console.' };
        }
      }
      if (get().activeUser?.id === userId) {
        return { ok: false, message: 'This account is signed in at the till. Switch cashier first, then deactivate it.' };
      }
    }

    await dbService.updateUser({ ...user, status });
    await get().loadUsers();
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return { ok: true };
  },

  countStaffRecords: async (userId: string) => {
    const counts = await dbService.countRecordsForUser(userId);
    return {
      ...counts,
      total: counts.tickets + counts.shifts + counts.expenses + counts.auditLogs,
    };
  },

  deleteStaffMember: async (userId: string) => {
    get().assertAdminRole();
    const user = get().users.find(u => u.id === userId);
    if (!user) return { ok: false, message: 'That staff account no longer exists.' };

    // The admin *is* the account — its id is the tenant key every synced row is scoped by.
    if (user.role === 'admin') {
      return { ok: false, message: 'The admin account owns this business and cannot be deleted here.' };
    }
    if (get().activeUser?.id === userId) {
      return { ok: false, message: 'This account is signed in at the till. Switch cashier first.' };
    }

    // Nothing cascades. A ticket keeps only a cashierId, so deleting an account that took
    // even one of them leaves that history permanently nameless — which is why this is
    // refused outright and deactivation offered instead, rather than warned about.
    const counts = await get().countStaffRecords(userId);
    if (counts.total > 0) {
      const parts = [
        counts.tickets && `${counts.tickets} ticket${counts.tickets === 1 ? '' : 's'}`,
        counts.shifts && `${counts.shifts} shift${counts.shifts === 1 ? '' : 's'}`,
        counts.expenses && `${counts.expenses} expense${counts.expenses === 1 ? '' : 's'}`,
        counts.auditLogs && `${counts.auditLogs} audit entr${counts.auditLogs === 1 ? 'y' : 'ies'}`,
      ].filter(Boolean);
      return {
        ok: false,
        message: `${user.name} owns ${parts.join(', ')}. Deleting the account would strip the name off those records for good — deactivate instead.`,
      };
    }

    await dbService.deleteUser(userId);
    await get().loadUsers();
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return { ok: true };
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
    const cleanKey = normaliseRecoveryKey(recoveryKey);

    const user = get().users.find(u => (u.username === target || u.email === target) && u.role === 'admin');
    if (!user) {
      return { ok: false, message: `No admin account on this till matches "${usernameOrEmail.trim()}".` };
    }
    if (!user.recoveryKeyHash || !user.recoveryKeySalt) {
      return {
        ok: false,
        message:
          'This account has no recovery key. Accounts created before recovery keys existed have none — ' +
          'sign in and issue one under Settings → Admin Recovery Key, or use the emailed password reset.',
      };
    }

    const isValidKey = await verifySecret(cleanKey, user.recoveryKeyHash, user.recoveryKeySalt);
    if (!isValidKey) return { ok: false, message: 'That recovery key does not match this account.' };

    const newSalt = generateSalt();
    const newPinHash = await hashSecretWithSalt(newPin, newSalt);

    // The cloud password is derived from the PIN, so the PIN cannot move without it.
    // Offline — which is the whole point of this route — there is no session to change it
    // through, so the till comes back but sync does not. Attempt it when we can, and be
    // explicit when we cannot rather than leaving a till quietly unable to reach the cloud.
    let cloudRealigned = false;
    if (isSupabaseConfigured && typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const { data } = await supabase.auth.getSession();
        if (data?.session) {
          await updateSupabaseUserPassword(deriveSupabasePassword(newPin));
          cloudRealigned = true;
        }
      } catch (_) {
        cloudRealigned = false;
      }
    }

    // A break-glass key is single use. Once it has been spent it is cleared, so a copy
    // that has been photographed, emailed to oneself or left in a drawer cannot be used
    // a second time. A replacement is issued from Settings.
    const updatedAdmin: UserAccount = {
      ...user,
      pinHash: newPinHash,
      pinSalt: newSalt,
      // null, not undefined — see the note on UserAccount.recoveryKeyHash. An undefined
      // never reaches Supabase, so the spent key would be pulled straight back.
      recoveryKeyHash: null,
      recoveryKeySalt: null,
    };

    await dbService.updateUser(updatedAdmin);
    await get().loadUsers();
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });

    return {
      ok: true,
      cloudRealigned,
      message: cloudRealigned
        ? 'PIN reset, and the cloud password was updated to match. Issue a new recovery key under Settings — this one is now spent.'
        : 'PIN reset on this till. Cloud sync will stay disconnected until you run the emailed password reset, because the cloud password is tied to the PIN. Issue a new recovery key under Settings — this one is now spent.',
    };
  },

  openPinModal: (purpose: string, onVerify: (success: boolean) => void, scope = 'admin' as const) => {
    set({
      isPinModalOpen: true,
      pinModalPurpose: purpose,
      pinChallengeCallback: onVerify,
      pinModalScope: scope,
    });
  },

  closePinModal: () => {
    set({
      isPinModalOpen: false,
      pinModalPurpose: null,
      pinChallengeCallback: null,
      // Back to the stricter default, so a later challenge can never inherit a
      // screen-lock's looser scope by accident.
      pinModalScope: 'admin',
    });
  },

  validatePin: async (pin: string) => {
    const { users, pinModalScope, activeUser } = get();

    // An admin PIN satisfies every challenge, including a cashier's screen lock — a
    // manager must always be able to take over a till.
    const candidates = users.filter(u => u.role === 'admin' && u.status === 'active');

    // A screen lock only asks "is this still the same person?", so the signed-in user's
    // own PIN unlocks it too.
    //
    // 'cashier' asks the same question for a different reason: the cashier is signing for
    // something done out of their own till — money taken from the drawer — so it is their
    // PIN that has to be on it. An admin PIN still passes, as it does everywhere.
    if (
      (pinModalScope === 'session' || pinModalScope === 'cashier') &&
      activeUser &&
      !candidates.some(u => u.id === activeUser.id)
    ) {
      candidates.push(activeUser);
    }

    let isValid = false;
    for (const candidate of candidates) {
      const match = await verifySecret(pin, candidate.pinHash, candidate.pinSalt);
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
    if (active?.role === 'admin') return;
    // An admin PIN entered at the console door proves the same authority as being signed
    // in as the admin — see hasAdminAuthority.
    if (get().hasAdminAuthority) return;
    throw new Error('Security Access Denied: Action requires an active Admin role');
  },
}));
