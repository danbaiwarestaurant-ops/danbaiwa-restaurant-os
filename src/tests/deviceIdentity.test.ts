/**
 * deviceIdentity.test.ts
 *
 * A till now signs in to the cloud as itself rather than borrowing the owner's login, so
 * that it can restore its own connection with nobody present. That introduces one way to
 * lose data silently: a till's own auth id owns no rows, so if the tenant key were taken
 * from `session.user.id` — as it was when the only session was ever the owner's — every
 * row this till wrote would be stamped with an id that matches no policy and belongs to
 * no account. It would sync "successfully" into invisibility.
 *
 * These tests pin the resolution rule, and the enrolment boundary that keeps a till from
 * granting itself access.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

const OWNER = 'owner-account-uuid';
const TILL = 'till-auth-uuid';

let sessionValue: any = null;
let signUpResult: any = { data: { user: { id: TILL } }, error: null };
let inserted: any[] = [];
let insertError: { message: string } | null = null;
let preflightError: { message: string } | null = null;
let signInCalls: { email: string; password: string }[] = [];
let signInError: { message: string } | null = null;

vi.mock('@supabase/supabase-js', () => ({
  // The throwaway client used for enrolment, so the owner's session is never clobbered.
  createClient: () => ({
    auth: {
      signUp: vi.fn(async () => signUpResult),
    },
  }),
}));

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionValue } })),
      signInWithPassword: vi.fn(async (creds: any) => {
        signInCalls.push(creds);
        if (signInError) return { data: null, error: signInError };
        sessionValue = {
          access_token: 'till-token',
          user: { id: TILL, user_metadata: { kind: 'pos-till', account_id: OWNER } },
        };
        return { data: { session: sessionValue }, error: null };
      }),
    },
    from: vi.fn(() => ({
      insert: vi.fn(async (row: any) => {
        inserted.push(row);
        return { error: insertError };
      }),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: async () => ({ data: { status: 'active' }, error: null }) })),
        // Pre-flight probe: enrolment must confirm the membership table is reachable
        // before creating an auth user it might not be able to grant access to.
        limit: vi.fn(async () => ({ data: [], error: preflightError })),
      })),
    })),
    rpc: vi.fn(async () => ({ error: null })),
  },
}));

import {
  resolveAccountId,
  ensureDeviceEnrolled,
  restoreDeviceSession,
  loadDeviceIdentity,
  saveDeviceIdentity,
  clearDeviceIdentity,
} from '../services/supabase/deviceIdentity';

const ownerSession = { access_token: 't', user: { id: OWNER, user_metadata: {} } };
const tillSession = {
  access_token: 't',
  user: { id: TILL, user_metadata: { kind: 'pos-till', account_id: OWNER } },
};

describe('device identity', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    sessionValue = null;
    inserted = [];
    insertError = null;
    preflightError = null;
    signInCalls = [];
    signInError = null;
    signUpResult = { data: { user: { id: TILL } }, error: null };
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
  });

  describe('resolveAccountId', () => {
    it('resolves an owner session to the owner', async () => {
      expect(await resolveAccountId(ownerSession)).toBe(OWNER);
    });

    it('resolves a till session to the account it is enrolled with, never to itself', async () => {
      // The whole hazard: stamping rows with TILL would file them under an id that owns
      // nothing, hiding them from the owner and every other device.
      await saveDeviceIdentity({
        authUserId: TILL,
        email: 'till@x.invalid',
        password: 'p',
        accountId: OWNER,
        enrolledAt: new Date().toISOString(),
      });
      expect(await resolveAccountId(tillSession)).toBe(OWNER);
    });

    it('falls back to the account claim in the till JWT when local identity is missing', async () => {
      // Local storage can be cleared while the session survives. Reading the claim keeps
      // the stamping correct instead of quietly reverting to the till's own id.
      await clearDeviceIdentity();
      expect(await resolveAccountId(tillSession)).toBe(OWNER);
    });

    it('answers with no network at all', async () => {
      await saveDeviceIdentity({
        authUserId: TILL,
        email: 'till@x.invalid',
        password: 'p',
        accountId: OWNER,
        enrolledAt: new Date().toISOString(),
      });
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: false },
        configurable: true,
        writable: true,
      });
      // Rows are stamped as they are written, which happens offline constantly.
      expect(await resolveAccountId(tillSession)).toBe(OWNER);
    });

    it('returns null for no session', async () => {
      expect(await resolveAccountId(null)).toBeNull();
    });
  });

  describe('enrolment', () => {
    it('records the membership under the owner and stores the till credential locally', async () => {
      sessionValue = ownerSession;

      const identity = await ensureDeviceEnrolled({ deviceId: 'DEV01', locationId: 'LOC01' });

      expect(identity?.authUserId).toBe(TILL);
      expect(identity?.accountId).toBe(OWNER);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        auth_user_id: TILL,
        account_id: OWNER,
        status: 'active',
      });
      expect((await loadDeviceIdentity())?.authUserId).toBe(TILL);
    });

    it('gives the till a credential of its own, not one derived from any PIN', async () => {
      sessionValue = ownerSession;
      const identity = await ensureDeviceEnrolled();
      // The owner's cloud password is `Danbaiwa_POS_#2026_<pin>_Secret`. A till holding
      // anything resembling that would hand an owner-account takeover to whoever picks
      // the machine up.
      expect(identity!.password).not.toMatch(/Danbaiwa_POS/);
      expect(identity!.password.length).toBeGreaterThan(40);
    });

    it('refuses to enrol from a till session — only an owner can admit a device', async () => {
      sessionValue = tillSession;
      expect(await ensureDeviceEnrolled()).toBeNull();
      expect(inserted).toHaveLength(0);
    });

    it('does nothing without a session', async () => {
      sessionValue = null;
      expect(await ensureDeviceEnrolled()).toBeNull();
      expect(inserted).toHaveLength(0);
    });

    it('does not store an identity when the membership row is rejected', async () => {
      // An identity that authenticates but reaches nothing is worse than none: the till
      // would look connected and sync nothing at all.
      sessionValue = ownerSession;
      insertError = { message: 'permission denied' };

      expect(await ensureDeviceEnrolled()).toBeNull();
      expect(await loadDeviceIdentity()).toBeNull();
    });

    it('creates no auth user at all when the membership table is unreachable', async () => {
      // A deployment whose schema migration has not been run yet. signUp cannot be undone
      // from the client, so attempting it here would leave an unusable orphan till in the
      // account's auth users on every single sign-in.
      sessionValue = ownerSession;
      preflightError = { message: 'relation "account_devices" does not exist' };

      expect(await ensureDeviceEnrolled()).toBeNull();
      expect(inserted).toHaveLength(0);
      expect(await loadDeviceIdentity()).toBeNull();
    });

    it('is idempotent — an enrolled till never signs up a second identity', async () => {
      sessionValue = ownerSession;
      await ensureDeviceEnrolled();
      inserted = [];
      await ensureDeviceEnrolled();
      expect(inserted).toHaveLength(0);
    });
  });

  describe('restoring the session', () => {
    it('signs the till back in on its own credential, with no PIN involved', async () => {
      await saveDeviceIdentity({
        authUserId: TILL,
        email: 'till@x.invalid',
        password: 'till-secret',
        accountId: OWNER,
        enrolledAt: new Date().toISOString(),
      });
      sessionValue = null;

      expect(await restoreDeviceSession()).toBe(true);
      expect(signInCalls).toEqual([{ email: 'till@x.invalid', password: 'till-secret' }]);
    });

    it('leaves an existing session alone', async () => {
      sessionValue = ownerSession;
      await saveDeviceIdentity({
        authUserId: TILL,
        email: 'till@x.invalid',
        password: 'p',
        accountId: OWNER,
        enrolledAt: new Date().toISOString(),
      });

      expect(await restoreDeviceSession()).toBe(true);
      expect(signInCalls).toHaveLength(0); // the owner's session must not be replaced
    });

    it('reports failure rather than throwing when the till is not enrolled', async () => {
      sessionValue = null;
      expect(await restoreDeviceSession()).toBe(false);
    });

    it('reports failure rather than throwing when the credential is rejected', async () => {
      await saveDeviceIdentity({
        authUserId: TILL,
        email: 'till@x.invalid',
        password: 'stale',
        accountId: OWNER,
        enrolledAt: new Date().toISOString(),
      });
      sessionValue = null;
      signInError = { message: 'invalid login credentials' };

      expect(await restoreDeviceSession()).toBe(false);
    });

    it('does not attempt a sign-in while offline', async () => {
      await saveDeviceIdentity({
        authUserId: TILL,
        email: 'till@x.invalid',
        password: 'p',
        accountId: OWNER,
        enrolledAt: new Date().toISOString(),
      });
      sessionValue = null;
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: false },
        configurable: true,
        writable: true,
      });

      expect(await restoreDeviceSession()).toBe(false);
      expect(signInCalls).toHaveLength(0);
    });
  });
});
