/**
 * accountScope.ts
 *
 * The tenant key for the whole sync layer: the admin's Supabase auth user id.
 *
 * This replaces the previous `location_id` scoping, which was scoped by a
 * `user_metadata.location_id` claim that was only ever written at signup — absent on
 * every account created before that code existed, and defaulted to the literal 'LOC01'
 * on every install that did have it. The first case silently locked an account out of
 * its own data; the second silently pooled unrelated accounts together.
 *
 * `auth.uid()` is the JWT's native `sub` claim. It is always present, never needs
 * populating, and cannot drift when settings change — so neither failure is
 * representable here.
 *
 * Cashiers hold no cloud identity. They never authenticate to Supabase; cashier rows
 * simply carry their account's id.
 *
 * The session doing the syncing is NOT always the owner's, though. A till enrols as its
 * own auth user so it can restore its own connection without anyone present (see
 * deviceIdentity.ts), and a till's own auth id owns no rows at all — so the tenant key
 * has to be resolved from the session rather than assumed to be `session.user.id`.
 * Stamping rows with a till's id instead of its account would hide that data from
 * everyone, the owner included.
 */

import { supabase, isSupabaseConfigured } from '../supabase/supabaseClient';
import { resolveAccountId } from '../supabase/deviceIdentity';
import { db } from './dexieSchema';

/** Dexie tables whose rows belong to an account and must carry accountId. */
const SCOPED_DEXIE_TABLES = ['users', 'tickets', 'shifts', 'expenses', 'auditLogs'] as const;

/**
 * The current tenant id, or null when this browser holds no cloud session.
 * Read from the live session rather than cached, so it can never go stale against a
 * different account signing in on the same device.
 */
export async function getAccountId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data } = await supabase.auth.getSession();
    if (!data?.session) return null;
    return await resolveAccountId(data.session);
  } catch (_) {
    return null;
  }
}

/**
 * The tenant id the **cloud** resolves for this session, straight from the database's own
 * current_account_id() — the exact expression every RLS policy compares against.
 *
 * The client's answer and the server's can disagree, and when they do nothing syncs while
 * everything looks healthy: the till holds a valid session, stamps its rows with the
 * account it was enrolled to, and the server — seeing an enrolment that has been revoked
 * or deleted — falls back to the till's own auth id and matches none of it. That is
 * invisible from the client side, which is why it has to be asked rather than inferred.
 *
 * `ok: false` means the question could not be put (offline, or the migration that adds
 * the function has not been run), which is not the same as "they disagree".
 */
export async function getServerAccountId(): Promise<{ ok: boolean; accountId: string | null }> {
  if (!isSupabaseConfigured) return { ok: false, accountId: null };
  try {
    const { data, error } = await supabase.rpc('current_account_id');
    if (error) return { ok: false, accountId: null };
    return { ok: true, accountId: (data as string | null) ?? null };
  } catch (_) {
    return { ok: false, accountId: null };
  }
}

/**
 * Stamps every local row that has no accountId with the given one.
 *
 * This is what rescues history created before account scoping existed: those rows are
 * owned by nobody, so the backfill sweep could never upload them and no other device
 * could ever see them. Runs before the backfill in runCloudCatchUp.
 *
 * Writes straight to Dexie rather than through IndexedDbService.saveX — exactly as
 * remoteMerge.ts does, and for the same reason: those methods queue an outbox row, and
 * stamping every historical row would enqueue a duplicate push for each one. The
 * backfill decides what genuinely needs uploading by diffing against the cloud.
 *
 * Returns how many rows were stamped.
 */
export async function stampLocalRowsWithAccount(accountId: string): Promise<number> {
  if (!accountId) return 0;

  let stamped = 0;

  for (const tableName of SCOPED_DEXIE_TABLES) {
    const table = (db as any)[tableName];
    if (!table) continue;

    try {
      const rows: any[] = await table.toArray();
      const unstamped = rows.filter((r) => r && !r.accountId);
      if (!unstamped.length) continue;

      await db.transaction('rw', table, async () => {
        for (const row of unstamped) {
          await table.put({ ...row, accountId });
        }
      });
      stamped += unstamped.length;
    } catch (e) {
      console.warn(`[accountScope] could not stamp local ${tableName} rows:`, e);
    }
  }

  if (stamped) {
    console.info(`[accountScope] stamped ${stamped} local row(s) with the signed-in account`);
  }
  return stamped;
}
