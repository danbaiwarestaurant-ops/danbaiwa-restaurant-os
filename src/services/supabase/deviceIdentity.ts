/**
 * deviceIdentity.ts
 *
 * A till's own cloud identity, so it can re-authenticate itself without a human.
 *
 * The problem this solves: the only cloud identity used to be the owner's, and the only
 * way to obtain one was the admin PIN. Cashiers hold no cloud identity at all, so the
 * moment a till lost its session it went silent — queueing locally, invisible to every
 * other device — until the owner physically came and typed their PIN. An owner running
 * the business remotely cannot be that dependency.
 *
 * A till now enrols as its own Supabase auth user and reaches the account's data through
 * a membership row (`account_devices`), rather than by borrowing the owner's login:
 *
 *   * it can sign itself back in, so sync heals without anyone present;
 *   * a stolen till can write that account's tickets but holds no credential of the
 *     owner's — previously an unlocked till carried a live owner session that could
 *     change the owner's own password;
 *   * access is revocable per device, remotely, without changing anyone's PIN.
 *
 * Enrolment requires a live *owner* session, by design: the membership row is inserted
 * under the owner's own auth.uid(), so a till can neither enrol itself nor move itself to
 * another account. See the DEVICE IDENTITY section of supabase_schema.sql.
 */

import { createClient } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient';
import { db } from '../db/dexieSchema';

const IDENTITY_KEY = 'device_cloud_identity';

/** Marks a till's auth user as a till, in a claim that rides along in its own JWT. */
export const TILL_USER_KIND = 'pos-till';

export interface DeviceIdentity {
  /** The till's own Supabase auth user id. */
  authUserId: string;
  email: string;
  /** The till's own credential — never the owner's, and never derived from any PIN. */
  password: string;
  /** The account whose data this till is enrolled to reach. */
  accountId: string;
  enrolledAt: string;
}

/**
 * Address for a till's auth user. Never receives mail — it exists only because Supabase
 * Auth identifies users by email — so the domain is a placeholder. `.invalid` is reserved
 * by RFC 2606 for exactly this, but some projects run stricter address validation, hence
 * the fallbacks: enrolment tries each in turn rather than failing outright.
 */
const TILL_EMAIL_DOMAINS = ['danbaiwa-pos.invalid', 'tills.danbaiwa-pos.app', 'danbaiwapos.com'];

function tillEmail(domain: string): string {
  return `till-${crypto.randomUUID()}@${domain}`;
}

/** A credential nobody types and nobody can guess — this is not a PIN-derived password. */
function generateDevicePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  // Padded to satisfy any password policy that wants mixed classes.
  return `Till#${body}Aa1`;
}

export async function loadDeviceIdentity(): Promise<DeviceIdentity | null> {
  try {
    const row = await db.config.get(IDENTITY_KEY);
    return (row?.value as DeviceIdentity) ?? null;
  } catch (_) {
    return null;
  }
}

export async function saveDeviceIdentity(identity: DeviceIdentity): Promise<void> {
  await db.config.put({ key: IDENTITY_KEY, value: identity });
}

export async function clearDeviceIdentity(): Promise<void> {
  await db.config.delete(IDENTITY_KEY);
}

/** Whether the live session belongs to a till rather than a person. */
export function isTillSession(session: any): boolean {
  return session?.user?.user_metadata?.kind === TILL_USER_KIND;
}

/**
 * The account this session may act for.
 *
 * An owner session is its own account. A till session must resolve to the account it was
 * enrolled with — its own auth id owns no rows at all, and stamping data with it would
 * make that data invisible to everyone including the owner.
 *
 * Resolved locally (stored identity first, then the account_id claim carried in the
 * till's JWT) so it still answers correctly with no network, which matters because this
 * is what stamps rows as they are written.
 */
export async function resolveAccountId(session: any): Promise<string | null> {
  const sessionUserId = session?.user?.id ?? null;
  if (!sessionUserId) return null;

  const identity = await loadDeviceIdentity();
  if (identity && identity.authUserId === sessionUserId) return identity.accountId;

  const claimed = session?.user?.user_metadata?.account_id;
  if (isTillSession(session) && typeof claimed === 'string' && claimed) return claimed;

  return sessionUserId;
}

/**
 * Enrol this till, if it is not enrolled already. Requires a live owner session.
 *
 * The new auth user is created on a throwaway client so the owner's session on the main
 * client is left exactly as it was — `signUp` signs you in as the user it creates, and
 * losing the owner session here would take the very authority needed to write the
 * membership row.
 */
export async function ensureDeviceEnrolled(opts: {
  deviceId?: string;
  locationId?: string;
  label?: string;
} = {}): Promise<DeviceIdentity | null> {
  if (!isSupabaseConfigured) return null;

  const existing = await loadDeviceIdentity();
  if (existing) return existing;

  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;
  if (!session) return null;

  // A till cannot enrol another till: the membership row is written under the caller's
  // own auth.uid(), which for a till session is not an account at all.
  if (isTillSession(session)) return null;

  const accountId = session.user.id;

  // Pre-flight before creating anything. `signUp` is not reversible from the client, so
  // attempting it against a project where the membership table is missing or unreadable
  // would litter the account's auth users with an orphan till on every single sign-in —
  // and each one would be unusable, since the row that grants it access is what failed.
  // Also the graceful path for a deployment whose schema migration has not been run yet:
  // the app simply carries on using the owner's session, exactly as it did before.
  const { error: preflightError } = await supabase
    .from('account_devices')
    .select('auth_user_id')
    .limit(1);

  if (preflightError) {
    console.warn(
      '[deviceIdentity] device enrolment unavailable (account_devices not reachable):',
      preflightError.message
    );
    return null;
  }

  const password = generateDevicePassword();

  const enrolClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  let authUserId: string | null = null;
  let usedEmail = '';
  let lastError = '';

  for (const domain of TILL_EMAIL_DOMAINS) {
    const email = tillEmail(domain);
    const { data, error } = await enrolClient.auth.signUp({
      email,
      password,
      options: { data: { kind: TILL_USER_KIND, account_id: accountId } },
    });

    if (!error && data.user) {
      authUserId = data.user.id;
      usedEmail = email;
      break;
    }
    lastError = error?.message ?? 'unknown sign-up error';
    console.warn(`[deviceIdentity] till sign-up rejected for @${domain}: ${lastError}`);
  }

  if (!authUserId) {
    console.warn('[deviceIdentity] could not create a cloud identity for this till:', lastError);
    return null;
  }

  // Written with the OWNER's session — this is the step a till could never perform for
  // itself, and what makes enrolment an act of the account rather than of the device.
  const { error: membershipError } = await supabase.from('account_devices').insert({
    auth_user_id: authUserId,
    account_id: accountId,
    device_id: opts.deviceId ?? null,
    location_id: opts.locationId ?? null,
    label: opts.label ?? null,
    status: 'active',
    last_seen_at: new Date().toISOString(),
  });

  if (membershipError) {
    // Without the membership row the till's identity can authenticate but reaches
    // nothing, which is worse than not enrolling: it would look connected and sync
    // nothing. Leave it unenrolled so the next owner sign-in tries again.
    console.warn('[deviceIdentity] enrolment rejected by the cloud:', membershipError.message);
    return null;
  }

  const identity: DeviceIdentity = {
    authUserId,
    email: usedEmail,
    password,
    accountId,
    enrolledAt: new Date().toISOString(),
  };
  await saveDeviceIdentity(identity);
  console.info('[deviceIdentity] this till is now enrolled with the account in its own right');
  return identity;
}

/**
 * Sign the till back in on its own credential. This is the whole point of the exercise:
 * it needs no PIN, no admin, and nobody present.
 *
 * Returns false when there is nothing to restore with — never throws, because every
 * caller is on a path that must continue working offline.
 */
export async function restoreDeviceSession(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;

  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session) return true;

    const identity = await loadDeviceIdentity();
    if (!identity) return false;

    const { error } = await supabase.auth.signInWithPassword({
      email: identity.email,
      password: identity.password,
    });

    if (error) {
      console.warn('[deviceIdentity] this till could not sign itself back in:', error.message);
      return false;
    }

    console.info('[deviceIdentity] cloud session restored by the till itself — no PIN needed');
    void reportDeviceSeen();
    return true;
  } catch (e) {
    console.warn('[deviceIdentity] session restore threw:', e);
    return false;
  }
}

/** Records that this till is alive, for the owner's device list. Best-effort. */
export async function reportDeviceSeen(): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabase.rpc('touch_device_last_seen');
  } catch (_) {
    /* the fleet list showing a stale timestamp is not worth surfacing */
  }
}

/**
 * Whether this till's access has been revoked by the owner.
 *
 * Worth asking explicitly: a revoked till authenticates perfectly well, it simply matches
 * no rows any more. Without this check the badge would report a healthy connection while
 * nothing whatsoever synced.
 */
export async function isDeviceRevoked(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;

  const identity = await loadDeviceIdentity();
  if (!identity) return false;

  try {
    const { data, error } = await supabase
      .from('account_devices')
      .select('status')
      .eq('auth_user_id', identity.authUserId)
      .maybeSingle();

    if (error || !data) return false; // can't tell — don't cry wolf
    return data.status !== 'active';
  } catch (_) {
    return false;
  }
}
