import { createClient } from '@supabase/supabase-js';

// Read Supabase environment variables safely with fallback
const metaEnv = (import.meta as any).env || {};
export const SUPABASE_URL = metaEnv.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
export const SUPABASE_ANON_KEY = metaEnv.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key';

export const isSupabaseConfigured = Boolean(
  SUPABASE_URL &&
  !SUPABASE_URL.includes('placeholder') &&
  SUPABASE_ANON_KEY &&
  !SUPABASE_ANON_KEY.includes('placeholder')
);

// Create a single global singleton instance of Supabase Client
export const supabase = createClient(
  isSupabaseConfigured ? SUPABASE_URL : 'https://placeholder.supabase.co',
  isSupabaseConfigured ? SUPABASE_ANON_KEY : 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);

// The admin's cloud (Supabase Auth) password is always derived from their PIN,
// never entered separately. Shared here so every call site derives it identically —
// authenticateAdminWithSupabase() and any code that changes the PIN and must keep
// the cloud password in lockstep with it.
export function deriveSupabasePassword(pin: string): string {
  return `Danbaiwa_POS_#2026_${pin}_Secret`;
}

/**
 * Where a Supabase email link (password reset, email confirmation) is allowed to land.
 *
 * Supabase honours `redirectTo` ONLY when the exact URL is on the project's allow-list
 * (Authentication > URL Configuration > Redirect URLs). Anything else is silently
 * swapped for the project's Site URL — no error, no warning. That is why reset links
 * kept opening the Vercel deployment instead of the till the operator was standing at:
 * tills run on http://localhost:5173 or a LAN address, neither of which is allow-listed
 * by default, so every link fell back to the Site URL.
 *
 * VITE_AUTH_REDIRECT_URL pins it for installs whose own URL is not the one that should
 * receive the link (a kiosk shortcut, a LAN address that moves); otherwise the page the
 * operator is actually looking at is used.
 */
export function authRedirectUrl(): string {
  const configured = String(metaEnv.VITE_AUTH_REDIRECT_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (typeof window === 'undefined') return '';
  const path = window.location.pathname.replace(/\/+$/, '');
  return `${window.location.origin}${path}`;
}

const accountExistsMessage = (email: string) =>
  `An account for "${email}" already exists in the cloud. Log in with that email and its admin PIN — this till will pull the account and all of its records down.`;

export type NewAccountResult =
  | { ok: true; userId: string; email: string; session: any }
  | { ok: false; reason: 'account_exists' | 'signup_failed'; message: string };

/**
 * First-launch signup, which must REFUSE an email that already owns a cloud account.
 *
 * authenticateAdminWithSupabase() signs in first and falls back to signing up. That is
 * right for re-establishing a session and catastrophic for registration: on a browser
 * profile that has never held the account it quietly hands back the EXISTING account,
 * and the caller then writes fresh PIN/password hashes and a fresh recovery key over a
 * live business's credentials and syncs them up. This is the same call sequence with the
 * opposite verdict — an account that already exists is an error here, not a success.
 */
export async function signUpNewAdminAccount(
  email: string,
  pin: string,
  locationId?: string
): Promise<NewAccountResult> {
  const cleanEmail = email.trim().toLowerCase();

  if (!isSupabaseConfigured) {
    return { ok: true, userId: crypto.randomUUID(), email: cleanEmail, session: null };
  }

  // Only a definite false means offline. Anything else — a runtime with no navigator,
  // or one whose navigator has no onLine at all — must be allowed to try the network
  // rather than be declared offline on the strength of an absent property.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      ok: false,
      reason: 'signup_failed',
      message: 'Internet connection required to create the cloud account for this till.',
    };
  }

  const derivedPassword = deriveSupabasePassword(pin);

  // Already live under this PIN? Then it is somebody's business, not a new one.
  const { data: signInData } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password: derivedPassword,
  });
  if (signInData?.user) {
    // Leave no half-authenticated session behind on a registration we are refusing.
    try {
      await supabase.auth.signOut();
    } catch {
      /* the refusal stands either way */
    }
    return { ok: false, reason: 'account_exists', message: accountExistsMessage(cleanEmail) };
  }

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email: cleanEmail,
    password: derivedPassword,
    options: {
      data: {
        role: 'admin',
        business_name: 'Danbaiwa Restaurant',
        location_id: locationId || 'LOC01',
      },
    },
  });

  if (signUpError) {
    const raw = signUpError.message.toLowerCase();
    if (raw.includes('already registered') || raw.includes('already exists')) {
      return { ok: false, reason: 'account_exists', message: accountExistsMessage(cleanEmail) };
    }
    return {
      ok: false,
      reason: 'signup_failed',
      message: `Supabase sign-up failed: ${signUpError.message}`,
    };
  }

  // With email confirmations switched on, Supabase does NOT report a duplicate as an
  // error. It returns a user object with an empty `identities` array — deliberately, so
  // a stranger cannot enumerate who holds an account. That obfuscated shape is the only
  // signal available, and treating it as success is precisely how one email came to be
  // "registered" a second time from a second browser profile.
  if (signUpData?.user && (signUpData.user.identities?.length ?? 0) === 0) {
    return { ok: false, reason: 'account_exists', message: accountExistsMessage(cleanEmail) };
  }

  if (!signUpData?.user) {
    return {
      ok: false,
      reason: 'signup_failed',
      message: 'Supabase accepted the sign-up but returned no account. Please try again.',
    };
  }

  return {
    ok: true,
    userId: signUpData.user.id,
    email: signUpData.user.email || cleanEmail,
    session: signUpData.session,
  };
}

/**
 * Real Supabase Cloud Email Authentication Engine
 */
export async function authenticateAdminWithSupabase(email: string, pin: string, locationId?: string) {
  const cleanEmail = email.trim().toLowerCase();

  if (!isSupabaseConfigured) {
    return {
      userId: crypto.randomUUID(),
      email: cleanEmail,
      session: null,
      isNewUser: true,
    };
  }

  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  if (!isOnline) {
    throw new Error('Internet connection required for initial Supabase Cloud Admin activation.');
  }

  const derivedPassword = deriveSupabasePassword(pin);

  // 1. Attempt Supabase Auth Sign In first
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password: derivedPassword,
  });

  if (!signInError && signInData.user) {
    return {
      userId: signInData.user.id,
      email: signInData.user.email,
      session: signInData.session,
      isNewUser: false,
    };
  }

  // 2. If Sign In failed, attempt Sign Up (New Registration)
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email: cleanEmail,
    password: derivedPassword,
    options: {
      data: {
        role: 'admin',
        business_name: 'Danbaiwa Restaurant',
        location_id: locationId || 'LOC01',
      },
    },
  });

  if (signUpError) {
    if (signUpError.message.toLowerCase().includes('already registered') || signUpError.message.toLowerCase().includes('already exists')) {
      throw new Error(`An account with email "${cleanEmail}" is already registered. Please log in instead.`);
    }
    throw new Error(`Supabase Email Auth Error: ${signUpError.message}`);
  }

  return {
    userId: signUpData.user?.id || crypto.randomUUID(),
    email: signUpData.user?.email || cleanEmail,
    session: signUpData.session,
    isNewUser: true,
  };
}

/**
 * Complete Supabase Magic Link Password Update
 */
export async function updateSupabaseUserPassword(newPassword: string) {
  if (!isSupabaseConfigured) return;

  // A till holds its own cloud identity now, and the till's session is what the app runs
  // on whenever no owner is signed in. Changing the password on *that* session would
  // silently rewrite the device's own credential — locking the till out of the cloud
  // permanently — while leaving the owner's account untouched, so a PIN change would
  // appear to work and break syncing instead. The owner has to be present for this.
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData?.session?.user?.user_metadata?.kind === 'pos-till') {
    throw new Error(
      'This till is signed in to the cloud as a device, not as you. Sign in with your admin email and PIN on this till before changing the cloud password.'
    );
  }

  const { data, error } = await supabase.auth.updateUser({
    password: newPassword,
  });
  if (error) {
    throw new Error(`Supabase Password Update Error: ${error.message}`);
  }
  return data;
}
