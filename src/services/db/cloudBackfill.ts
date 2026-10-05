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
import { selectPages } from '../supabase/pagedSelect';
import { db, stripUserRow, UserRow } from './dexieSchema';
import { getAccountId } from './accountScope';
import { dbService } from './IndexedDbService';
import { archivedStaff, STAFF_DELETION_ENTITY } from './staffIdentity';
import { SyncablePgTable, SyncableDexieTable } from './remoteMerge';

const BACKFILL_TABLES: { pg: SyncablePgTable; dexie: SyncableDexieTable }[] = [
  // Order matters: shifts must exist in the cloud before expenses, which carry a
  // NOT NULL foreign key onto them.
  { pg: 'users', dexie: 'users' },
  { pg: 'shifts', dexie: 'shifts' },
  { pg: 'tickets', dexie: 'tickets' },
  { pg: 'expenses', dexie: 'expenses' },
  // No foreign key of its own — a server's count references a user row, not a shift — so
  // its position here only has to be after users.
  { pg: 'server_sales', dexie: 'serverSales' },
  { pg: 'role_pay_configs', dexie: 'rolePayConfigs' },
  { pg: 'staff_assessments', dexie: 'staffAssessments' },
  { pg: 'wage_ledger', dexie: 'wageLedger' },
  { pg: 'inventory_items', dexie: 'inventoryItems' },
  { pg: 'inventory_batches', dexie: 'inventoryBatches' },
  { pg: 'inventory_movements', dexie: 'inventoryMovements' },
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
      // Ordered merge of two paged streams. A million records never become a
      // million-payload JS array or a million-ID Set on the till.
      const remote = selectPages<{ id: string }>(() => supabase.from(pg).select('id').eq('account_id', accountId));
      let remotePage: { id: string }[] = [];
      let remoteOffset = 0;
      let remoteDone = false;
      const peek = async (): Promise<string | undefined> => {
        if (remoteOffset >= remotePage.length && !remoteDone) {
          const next = await remote.next();
          remoteDone = Boolean(next.done);
          remotePage = next.value || [];
          remoteOffset = 0;
        }
        return remotePage[remoteOffset]?.id;
      };
      const removed = pg === 'users' ? new Set((await db.auditLogs.where('entity').equals(STAFF_DELETION_ENTITY).toArray())
        .filter(log => archivedStaff(log)).map(log => log.entityId)) : new Set<string>();
      const table = db[dexie] as any;
      let after: string | undefined;
      while (true) {
        const page: any[] = await (after ? table.where('id').above(after) : table.orderBy('id')).limit(500).toArray();
        if (!page.length) break;
        const missing: Record<string, any>[] = [];
        for (const row of page) {
          if ((row.accountId && row.accountId !== accountId) || row.rebuiltLocally || removed.has(row.id)) continue;
          let cloudId = await peek();
          while (cloudId !== undefined && cloudId < row.id) { remoteOffset++; cloudId = await peek(); }
          if (cloudId !== row.id) missing.push(toCloudPayload(pg, row));
        }
        if (missing.length) queuedTotal += await dbService.enqueueBackfill(pg, missing);
        after = page[page.length - 1].id;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await remote.return(undefined);
    } catch (e) {
      console.warn(`[cloudBackfill] backfill sweep failed for ${pg}:`, e);
    }
  }

  return queuedTotal;
}
