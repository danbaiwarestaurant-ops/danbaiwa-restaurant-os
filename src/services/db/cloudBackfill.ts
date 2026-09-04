/**
 * cloudBackfill.ts
 *
 * Reconciles the *upward* direction of sync: finds local rows the cloud has never
 * received and queues them for push.
 *
 * The outbox only ever captures rows at the moment they are mutated. Anything whose
 * outbox entry was lost — parked as permanently 'failed' by an older build, or created
 * during a stretch where this till held no Supabase session — was stranded on the
 * device with nothing in the system that would ever push it again. Reconciliation
 * (realtimeSync.ts) only pulls *down*, so it could never repair that either: a device
 * holding the only copy of a month of tickets would keep reporting itself as synced.
 *
 * This sweep closes that hole by comparing local ids against the ids the cloud actually
 * holds, and re-queueing the difference. It is additive only — it never deletes a local
 * row for being absent from the cloud, and never deletes a cloud row for being absent
 * locally.
 */

import { supabase, isSupabaseConfigured } from '../supabase/supabaseClient';
import { selectAllPages } from '../supabase/pagedSelect';
import { db, stripUserRow, UserRow } from './dexieSchema';
import { getAccountId } from './accountScope';
import { dbService } from './IndexedDbService';
import { SyncablePgTable } from './remoteMerge';

const BACKFILL_TABLES: { pg: SyncablePgTable; dexie: 'users' | 'tickets' | 'shifts' | 'expenses' | 'auditLogs' }[] = [
  // Order matters: shifts must exist in the cloud before expenses, which carry a
  // NOT NULL foreign key onto them.
  { pg: 'users', dexie: 'users' },
  { pg: 'shifts', dexie: 'shifts' },
  { pg: 'tickets', dexie: 'tickets' },
  { pg: 'expenses', dexie: 'expenses' },
  { pg: 'audit_logs', dexie: 'auditLogs' },
];

/** Strips fields that exist only in the local Dexie row and have no Postgres column. */
function toCloudPayload(pgTable: SyncablePgTable, row: any): Record<string, any> {
  if (pgTable === 'users') return stripUserRow(row as UserRow);
  return row;
}

/**
 * Compares local ids against cloud ids for every syncable table and queues whatever the
 * cloud is missing. Returns the number of rows queued. Safe to call repeatedly —
 * enqueueBackfill skips rows already in flight.
 */
export async function runBackfillPush(): Promise<number> {
  if (!isSupabaseConfigured) return 0;

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) return 0;

  const accountId = await getAccountId();
  if (!accountId) return 0;

  let queuedTotal = 0;

  for (const { pg, dexie } of BACKFILL_TABLES) {
    try {
      const localRows: any[] = await (db as any)[dexie].toArray();
      if (!localRows.length) continue;

      // Ask how many rows the cloud holds before asking which. `head: true` returns the
      // count in a header and no rows at all, so this costs nothing to transfer — whereas
      // the id list below is every id the account owns, which at 3,000 tickets a day is
      // megabytes. When the two agree there is nothing this sweep could queue, and the
      // expensive read is skipped entirely.
      //
      // Equal counts with differing ids is possible in principle (one row missing here,
      // an unrelated one missing there). It is repaired by the same statement on the next
      // sweep where the counts do differ, and the outbox — not this net — is what actually
      // gets a written row to the cloud.
      const { count, error: countError } = await supabase
        .from(pg)
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId);

      if (!countError && typeof count === 'number' && count >= localRows.length) continue;

      // Only ids are needed for the diff, so this stays cheap even on a long history.
      // Scoped to this account: without the filter another tenant's ids could read as
      // "already present" and this sweep would skip uploads it needed to make.
      //
      // Paged, because this diff treats every id it does not see as a row the cloud is
      // missing — and an unpaged select stops at the project's "Max rows" cap (1000 by
      // default) without saying so. Past that point the sweep re-queued the overflow on
      // every pass for ever, uploading rows the cloud already had, and the queue grew by
      // one with every ticket rung up. See selectAllPages.
      const { data, error } = await selectAllPages<{ id: string }>(() =>
        supabase.from(pg).select('id').eq('account_id', accountId)
      );
      if (error) {
        console.warn(`[cloudBackfill] could not read cloud ids for ${pg}:`, error.message);
        continue;
      }

      const remoteIds = new Set((data ?? []).map((r: any) => r.id));
      const missing = localRows
        .filter((r) => r?.id && !remoteIds.has(r.id))
        // A profile this device rebuilt from a cloud sign-in is missing from the
        // cloud for a reason, and is exactly the row this sweep must not send: it
        // shares its id with the genuine profile the original till still owes, and
        // uploading it first would make the cloud skip the real one for ever after,
        // losing the owner's name, password hash and recovery key across every device.
        .filter((r) => !(pg === 'users' && r.rebuiltLocally))
        .map((r) => toCloudPayload(pg, r));

      if (!missing.length) continue;

      const queued = await dbService.enqueueBackfill(pg, missing);
      queuedTotal += queued;
      if (queued) {
        console.info(`[cloudBackfill] queued ${queued} local ${pg} row(s) the cloud was missing`);
      }
    } catch (e) {
      console.warn(`[cloudBackfill] backfill sweep failed for ${pg}:`, e);
    }
  }

  return queuedTotal;
}
