/**
 * accountSignup.test.ts
 *
 * "Create Account" was offered on any browser profile that held no local user, and its
 * only duplicate check was a `select('id').eq('email', ...)` against the users table.
 * That query runs on the anon key with no session, and every RLS policy on that table is
 * granted TO authenticated — so it answers "no such email" for an email that is very much
 * registered. Registration then went ahead and re-registered a live business, writing
 * fresh PIN, password and recovery-key hashes over the real ones.
 *
 * Supabase Auth is the only thing that actually knows, and it reports a duplicate two
 * different ways depending on a project setting nobody remembers changing. Both are
 * pinned here, along with the sign-in probe, because each one on its own leaves the door
 * open in a real configuration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let signInResult: any = { data: { user: null }, error: { message: 'Invalid login credentials' } };
let signUpResult: any = null;
let signOutCalls = 0;

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: vi.fn(async () => signInResult),
      signUp: vi.fn(async () => signUpResult),
      signOut: vi.fn(async () => {
        signOutCalls += 1;
        return { error: null };
      }),
    },
  }),
}));

async function loadClient() {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  vi.resetModules();
  return import('../services/supabase/supabaseClient');
}

describe('signUpNewAdminAccount', () => {
  beforeEach(() => {
    signInResult = { data: { user: null }, error: { message: 'Invalid login credentials' } };
    signUpResult = { data: { user: { id: 'new-uuid', email: 'new@shop.com', identities: [{ id: 'i1' }] }, session: {} }, error: null };
    signOutCalls = 0;
  });

  it('creates the account when the email is genuinely new', async () => {
    const { signUpNewAdminAccount } = await loadClient();
    const result = await signUpNewAdminAccount('new@shop.com', '1234', 'LOC01');

    expect(result.ok).toBe(true);
    expect(result.ok && result.userId).toBe('new-uuid');
  });

  it('refuses when the email already signs in — the account is somebody\'s live business', async () => {
    signInResult = { data: { user: { id: 'existing-uuid' } }, error: null };

    const { signUpNewAdminAccount } = await loadClient();
    const result = await signUpNewAdminAccount('owner@shop.com', '1234', 'LOC01');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('account_exists');
    // No half-authenticated session may be left behind by a registration we refused.
    expect(signOutCalls).toBe(1);
  });

  it('refuses on the obfuscated duplicate Supabase returns when email confirmations are on', async () => {
    // Not an error — a user object with an EMPTY identities array, so a stranger cannot
    // enumerate who holds an account. Treating this as success is exactly how one email
    // came to be "registered" a second time from a second browser profile.
    signUpResult = { data: { user: { id: 'obscured', email: 'owner@shop.com', identities: [] }, session: null }, error: null };

    const { signUpNewAdminAccount } = await loadClient();
    const result = await signUpNewAdminAccount('owner@shop.com', '9999', 'LOC01');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('account_exists');
  });

  it('refuses on the plain duplicate error Supabase returns when confirmations are off', async () => {
    signUpResult = { data: { user: null }, error: { message: 'User already registered' } };

    const { signUpNewAdminAccount } = await loadClient();
    const result = await signUpNewAdminAccount('owner@shop.com', '9999', 'LOC01');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('account_exists');
  });

  it('reports a genuine signup failure as such, not as a duplicate', async () => {
    signUpResult = { data: { user: null }, error: { message: 'Signups not allowed for this instance' } };

    const { signUpNewAdminAccount } = await loadClient();
    const result = await signUpNewAdminAccount('new@shop.com', '1234', 'LOC01');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('signup_failed');
  });
});
