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
  if (!isSupabaseConfigured) {
    return {
      userId: crypto.randomUUID(),
      email: email.trim().toLowerCase(),
      session: null,
      isNewUser: true,
    };
  }

  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  if (!isOnline) {
    throw new Error('Internet connection required for initial Supabase Cloud Admin activation.');
  }

  const derivedPassword = `Danbaiwa_POS_#2026_${pin}_Secret`;

  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
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

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password: derivedPassword,
    options: {
      data: {
        role: 'admin',
        business_name: 'Danbaiwa Restaurant',
      },
    },
  });

  if (signUpError) {
    throw new Error(`Supabase Email Auth Error: ${signUpError.message}`);
  }

  return {
    userId: signUpData.user?.id || crypto.randomUUID(),
    email: signUpData.user?.email || email,
    session: signUpData.session,
    isNewUser: true,
  };
}
