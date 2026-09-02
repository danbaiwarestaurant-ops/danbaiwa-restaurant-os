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

import { db, computeLoginKeys, UserRow } from './dexieSchema';

/** Postgres/outbox table names — the only tables realtime/reconciliation sync touches.
 *  sequences/config/outbox stay device-local and must never be written here. */
export type SyncablePgTable = 'users' | 'tickets' | 'shifts' | 'expenses' | 'audit_logs';

const DEXIE_TABLE: Record<SyncablePgTable, 'users' | 'tickets' | 'shifts' | 'expenses' | 'auditLogs'> = {
  users: 'users',
  tickets: 'tickets',
  shifts: 'shifts',
  expenses: 'expenses',
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

  // Indexed on status, so this reads only what is still owed rather than walking every
  // outbox row the device has ever written.
  const unsynced = await db.outbox.where('status').anyOf('pending', 'failed').toArray();
  if (unsynced.some((o) => o.tableName === 'account_settings')) return false;

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
  const rows = await db.outbox.where('status').anyOf('pending', 'failed').toArray();
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
  return (await loadDirtyIds(pgTable)).has(id);
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
  const dexieTable = db[DEXIE_TABLE[pgTable]] as any;
  const id = camelRow.id as string;
  if (!id) return false;

  const isDirty = dirtyIds ? dirtyIds.has(id) : await isRowDirty(pgTable, id);

  if (op === 'DELETE') {
    if (isDirty) return false;
    await dexieTable.delete(id);
    return true;
  }

  if (isDirty) return false;

  const existing = await dexieTable.get(id);
  if (!shouldApplyRemote(existing, camelRow)) return false;

  if (pgTable === 'users') {
    const row: UserRow = { ...(camelRow as any), loginKeys: computeLoginKeys(camelRow as any) };
    await dexieTable.put(row);
  } else {
    await dexieTable.put(camelRow);
  }
  return true;
}
