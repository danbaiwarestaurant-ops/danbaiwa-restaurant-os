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
