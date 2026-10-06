/**
 * remoteMerge.ts
 *
 * The one place in the codebase allowed to write to Dexie tables directly, bypassing
 * IndexedDbService's saveX/updateX methods. Those methods queue an outbox row on every
 * write — routing an incoming remote change through them would immediately re-queue it
 * for push, creating a push -> pull -> push loop. Everything here writes straight to
 * Dexie via `db[table].put(...)` instead.
 *
 * Two safety rules before any remote row is applied:
 * 1. Last-write-wins by the server-set `updatedAt` timestamp (never a client-stamped one).
 * 2. A row with a pending/failed outbox entry is never touched, regardless of timestamp —
 *    a stale remote pull must never clobber a local edit that hasn't synced up yet.
 */

import { db, computeLoginKeys } from './dexieSchema';
import { archivedStaff, STAFF_DELETION_ENTITY } from './staffIdentity';

async function permanentlyRemovedIds(): Promise<Set<string>> {
  const logs = await db.auditLogs.where('entity').equals(STAFF_DELETION_ENTITY).toArray();
  return new Set(logs.filter(log => archivedStaff(log)).map(log => log.entityId));
}

/** Postgres/outbox table names — the only tables realtime/reconciliation sync touches.
 *  sequences/config/outbox stay device-local and must never be written here. */
export type SyncablePgTable =
  | 'users'
  | 'tickets'
  | 'shifts'
  | 'expenses'
  | 'server_sales'
  | 'role_pay_configs'
  | 'staff_assessments'
  | 'wage_ledger'
  | 'inventory_items'
  | 'inventory_batches'
  | 'inventory_movements'
  | 'audit_logs';

/** The Dexie table each Postgres table lands in. */
export type SyncableDexieTable = 'users' | 'tickets' | 'shifts' | 'expenses' | 'serverSales' | 'rolePayConfigs' | 'staffAssessments' | 'wageLedger' | 'inventoryItems' | 'inventoryBatches' | 'inventoryMovements' | 'auditLogs';

const DEXIE_TABLE: Record<SyncablePgTable, SyncableDexieTable> = {
  users: 'users',
  tickets: 'tickets',
  shifts: 'shifts',
  expenses: 'expenses',
  server_sales: 'serverSales',
  role_pay_configs: 'rolePayConfigs',
  staff_assessments: 'staffAssessments',
  wage_ledger: 'wageLedger',
  inventory_items: 'inventoryItems',
  inventory_batches: 'inventoryBatches',
  inventory_movements: 'inventoryMovements',
  audit_logs: 'auditLogs',
};

const DEVICE_CONFIG_KEY = 'device_config';

/**
 * Applies account settings arriving from another device.
 *
 * Writes straight to the local config row rather than through
 * IndexedDbService.saveDeviceConfig, which queues an outbox row — routing an incoming
 * change through it would push it straight back, same push/pull loop applyRemoteRow
 * avoids. Last-write-wins on the server-set updatedAt, and skipped entirely while this
 * device has an unsynced config change of its own.
 *
 * Returns true if local config actually changed.
 */
export async function applyRemoteSettings(remote: {
  settings?: Record<string, any>;
  updatedAt?: string;
}): Promise<boolean> {
  if (!remote?.settings || typeof remote.settings !== 'object') return false;

  return db.transaction('rw', db.config, db.outbox, async () => {
  // Indexed on status, so this reads only what is still owed rather than walking every
  // outbox row the device has ever written.
  const dirty = await db.outbox.where('[tableName+status]')
    .anyOf([['account_settings', 'pending'], ['account_settings', 'failed']]).count();
  if (dirty) return false;

  const existing = await db.config.get(DEVICE_CONFIG_KEY);
  const localUpdatedAt = (existing?.value as any)?.__updatedAt as string | undefined;
  if (!shouldApplyRemote(localUpdatedAt ? { updatedAt: localUpdatedAt } : undefined, remote)) {
    return false;
  }

  // deviceId/deviceName are account-level by explicit product decision, so they are
  // carried across too. Ticket-id uniqueness does not depend on them — that comes from
  // the never-synced installation id (see IndexedDbService.getInstallationId).
  await db.config.put({
    key: DEVICE_CONFIG_KEY,
    value: { ...(existing?.value ?? {}), ...remote.settings, __updatedAt: remote.updatedAt },
  });
  return true;
  });
}

/**
 * Ids of this table's rows that are still owed to the cloud, as one indexed read.
 *
 * The per-row check below used `db.outbox.filter(...)`, which walks the entire outbox —
 * synced history included, and nothing ever prunes that — once for every incoming row.
 * The reconciliation pull applies every row of every table each minute, so the cost was
 * (all local records × all outbox rows ever) of IndexedDB work per sweep, on the same
 * thread the push worker and the UI run on. On a till with real history that is enough
 * to make the whole queue look frozen. Callers that apply many rows load the set once.
 */
export async function loadDirtyIds(pgTable: SyncablePgTable): Promise<Set<string>> {
  const rows = await db.outbox.where('[tableName+status]')
    .anyOf([[pgTable, 'pending'], [pgTable, 'failed']]).toArray();
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.tableName !== pgTable) continue;
    const id = (row.payload as any)?.id;
    if (id) ids.add(String(id));
  }
  return ids;
}

/** True when a pending/failed outbox entry exists for this row — it hasn't synced up yet. */
export async function isRowDirty(pgTable: SyncablePgTable, id: string): Promise<boolean> {
  return await db.outbox.where('[tableName+payload.id+status]')
    .anyOf([[pgTable, id, 'pending'], [pgTable, id, 'failed']]).count() > 0;
}

/** Last-write-wins: apply the incoming row only if it's strictly newer than what's local. */
export function shouldApplyRemote(existing: { updatedAt?: string } | undefined, incoming: { updatedAt?: string }): boolean {
  if (!existing) return true;
  if (!existing.updatedAt) return true;
  if (!incoming.updatedAt) return false;
  return incoming.updatedAt > existing.updatedAt;
}

/**
 * Applies one incoming remote row (already camelCase) to the matching local Dexie table.
 * Returns true if it actually wrote something, so callers know whether a store reload
 * is worth triggering.
 */
export async function applyRemoteRow(
  pgTable: SyncablePgTable,
  camelRow: Record<string, any>,
  op: 'INSERT' | 'UPDATE' | 'DELETE',
  /** Pre-loaded dirty ids, for callers applying a whole table's worth of rows. */
  dirtyIds?: Set<string>
): Promise<boolean> {
  // The optional snapshot is advisory only. A new local write can arrive after it.
  void dirtyIds;
  const table = db[DEXIE_TABLE[pgTable]] as any;
  return db.transaction('rw', table, db.outbox, db.auditLogs, db.users, async () => {
    const id = camelRow.id as string;
    if (pgTable === 'users' && (await permanentlyRemovedIds()).has(id)) return false;
    if (!id || await isRowDirty(pgTable, id)) return false;
    if (op === 'DELETE') {
      await table.delete(id);
      return true;
    }
    const existing = await table.get(id);
    if (!shouldApplyRemote(existing, camelRow)) return false;
    await table.put(normaliseRemote(pgTable, camelRow));
    if (pgTable === 'audit_logs' && archivedStaff(camelRow as any)) await db.users.delete(camelRow.entityId);
    return true;
  });
}

function normaliseRemote(pgTable: SyncablePgTable, row: Record<string, any>): Record<string, any> {
  if (pgTable === 'users') return { ...row, loginKeys: computeLoginKeys(row as any) };
  if (pgTable === 'tickets') return { ...row, qrPayload: row.qrPayload || ticketQrPayload(row as any) };
  return row;
}

/** Cloud pages usually cover adjacent IDs. Native getAll reads that span in one
 * request instead of issuing hundreds of IndexedDB get messages. A sparse
 * update page may cover many unrelated local IDs: cap the span and fall back to
 * exact bulkGet so neither memory nor last-write-wins depends on that density. */
async function existingPageRows(table: any, chunk: Record<string, any>[]): Promise<any[]> {
  const ids = chunk.map(row => row.id).sort();
  if (!ids.length) return [];
  const span = await table.where('id').between(ids[0], ids[ids.length - 1], true, true)
    .limit(ids.length + 1).toArray();
  if (span.length > ids.length) return table.bulkGet(chunk.map(row => row.id));
  const byId = new Map(span.map((row: any) => [row.id, row]));
  return chunk.map(row => byId.get(row.id));
}

/** Short, atomic merge transactions; dirty checks cannot race a ticket mutation. */
export async function applyRemoteRows(pgTable: SyncablePgTable, rows: Record<string, any>[]): Promise<boolean> {
  const table = db[DEXIE_TABLE[pgTable]] as any;
  let changed = false;
  for (let offset = 0; offset < rows.length; offset += 200) {
    const chunk = [...new Map(rows.slice(offset, offset + 200).filter(row => row.id).map(row => [row.id, row])).values()];
    changed = await db.transaction('rw', table, db.outbox, db.auditLogs, db.users, async () => {
      const [dirty, existing] = await Promise.all([
        db.outbox.where('[tableName+payload.id+status]')
          .anyOf(chunk.flatMap(row => [[pgTable, row.id, 'pending'], [pgTable, row.id, 'failed']]))
          .keys().then(keys => new Set(keys.map(key => String((key as any[])[1])))),
        existingPageRows(table, chunk),
      ]);
      const removed = pgTable === 'users' ? await permanentlyRemovedIds() : new Set<string>();
      const inserts: any[] = [], updates: any[] = [];
      chunk.forEach((row, i) => {
        if (removed.has(row.id) || dirty.has(row.id) || !shouldApplyRemote(existing[i], row)) return;
        (existing[i] ? updates : inserts).push(normaliseRemote(pgTable, row));
      });
      // A new row has no before-image. Using add preserves that fact through
      // Dexie's index/hooks middleware, avoiding another read per inserted row.
      if (inserts.length) await table.bulkAdd(inserts);
      if (updates.length) await table.bulkPut(updates);
      const writes = [...inserts, ...updates];
      if (pgTable === 'audit_logs') await db.users.bulkDelete(writes.filter(row => archivedStaff(row as any)).map(row => row.entityId));
      return writes.length > 0;
    }) || changed;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return changed;
}

/**
 * Rebuilds a ticket's QR text from the three fields it was made of.
 *
 * The cloud no longer stores qr_payload: it is ~60 bytes per ticket that says nothing the
 * row does not already say, and at 3,000 tickets a day per restaurant that is tens of
 * megabytes a year of pure repetition inside a 500 MB budget. Tickets that predate the
 * change still carry theirs, hence the `||` at the call site — a stored payload is always
 * used as-is.
 *
 * Must reproduce the original byte for byte, because it is what a reprint puts in the QR
 * code, and a reprint that scans differently from the paper it replaces is worse than no
 * reprint at all. Two details do that: `new Date(...).toISOString()` normalises Postgres's
 * `+00:00` back to the `Z` form the till minted, and a JSON number stringifies the same
 * way here as it did there. See createAndPrintTicket, which is the definition this mirrors.
 */
export function ticketQrPayload(row: {
  id: string;
  amount: number;
  createdAt: string;
}): string {
  const minted = new Date(row.createdAt);
  const stamp = Number.isNaN(minted.getTime()) ? row.createdAt : minted.toISOString();
  return `TICKET|${row.id}|${row.amount}|${stamp}`;
}
