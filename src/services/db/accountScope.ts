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
 * Cashiers hold no cloud identity. They never authenticate to Supabase; the admin's
 * session performs all syncing, and cashier rows simply carry their admin's accountId.
 */

import { supabase, isSupabaseConfigured } from '../supabase/supabaseClient';
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
    return data?.session?.user?.id ?? null;
  } catch (_) {
    return null;
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
