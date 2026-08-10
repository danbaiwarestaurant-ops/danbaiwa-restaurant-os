import { createClient } from '@supabase/supabase-js';

// Read Supabase environment variables safely with fallback
const metaEnv = (import.meta as any).env || {};
const SUPABASE_URL = metaEnv.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const SUPABASE_ANON_KEY = metaEnv.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key';

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

/**
 * Real Supabase Cloud Email Authentication Engine
 */
export async function authenticateAdminWithSupabase(email: string, pin: string) {
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

  const derivedPassword = `Danbaiwa_POS_#2026_${pin}_Secret`;

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
  const { data, error } = await supabase.auth.updateUser({
    password: newPassword,
  });
  if (error) {
    throw new Error(`Supabase Password Update Error: ${error.message}`);
  }
  return data;
}
