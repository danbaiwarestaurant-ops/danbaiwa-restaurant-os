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

  const dirty = await db.outbox
    .filter((o) => o.tableName === 'account_settings' && o.status !== 'synced')
    .first();
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
}

/** True when a pending/failed outbox entry exists for this row — it hasn't synced up yet. */
export async function isRowDirty(pgTable: SyncablePgTable, id: string): Promise<boolean> {
  const match = await db.outbox
    .filter((o) => o.tableName === pgTable && o.status !== 'synced' && (o.payload as any)?.id === id)
    .first();
  return Boolean(match);
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
  op: 'INSERT' | 'UPDATE' | 'DELETE'
): Promise<boolean> {
  const dexieTable = db[DEXIE_TABLE[pgTable]] as any;
  const id = camelRow.id as string;
  if (!id) return false;

  if (op === 'DELETE') {
    if (await isRowDirty(pgTable, id)) return false;
    await dexieTable.delete(id);
    return true;
  }

  if (await isRowDirty(pgTable, id)) return false;

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
