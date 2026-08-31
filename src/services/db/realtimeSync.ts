/**
 * realtimeSync.ts
 *
 * Keeps this device's local Dexie tables continuously reconciled with Postgres, so an
 * account's data is visible from every device it's ever logged into — not just the one
 * that created it. Two halves:
 *
 * 1. Realtime subscriptions: near-live propagation of changes from other devices.
 * 2. Reconciliation pull: fetches everything for this location on login/reconnect/
 *    a periodic timer, catching anything a dropped websocket missed. This also
 *    subsumes the old "restore only if local is empty" disaster-recovery gate — a
 *    merge is always safe to run, so a brand-new device's first login is just a pull
 *    like any other.
 *
 * All actual writes go through remoteMerge.ts's applyRemoteRow, which enforces
 * last-write-wins + "never clobber an unsynced local edit" — this file is only wiring.
 */

import { supabase, isSupabaseConfigured } from '../supabase/supabaseClient';
import { toCamelCase } from '../../utils/caseMapping';
import { applyRemoteRow, applyRemoteSettings, SyncablePgTable } from './remoteMerge';
import { useDeviceStore } from '../../store/useDeviceStore';
import { runBackfillPush } from './cloudBackfill';
import { getAccountId, stampLocalRowsWithAccount } from './accountScope';
import { dbService } from './IndexedDbService';
import { db } from './dexieSchema';
import { useSyncStore } from '../../store/useSyncStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useExpenseStore } from '../../store/useExpenseStore';
import { useAuditStore } from '../../store/useAuditStore';

const DEVICE_CONFIG_KEY = 'device_config';
const RECONCILIATION_INTERVAL_MS = 60_000;
const RELOAD_DEBOUNCE_MS = 150;

const SYNCABLE_TABLES: SyncablePgTable[] = ['users', 'tickets', 'shifts', 'expenses', 'audit_logs'];

let channel: ReturnType<typeof supabase.channel> | null = null;
let reconciliationInterval: ReturnType<typeof setInterval> | null = null;
let onlineListenerAttached = false;
const reloadTimers: Partial<Record<SyncablePgTable, ReturnType<typeof setTimeout>>> = {};

/** Tickets/expenses show an account-wide rollup for admins, but only "my own" for
 *  cashiers — mirrors App.tsx's loading scope so realtime-triggered reloads match. */
function scopedUserId(): string | undefined {
  const activeUser = useAuthStore.getState().activeUser;
  return activeUser?.role === 'admin' ? undefined : activeUser?.id;
}

function scheduleStoreReload(pgTable: SyncablePgTable): void {
  if (reloadTimers[pgTable]) clearTimeout(reloadTimers[pgTable]);
  reloadTimers[pgTable] = setTimeout(() => {
    switch (pgTable) {
      case 'tickets':
        useTicketStore.getState().loadTickets(scopedUserId());
        break;
      case 'shifts':
        // currentShift is a personal "is my shift open" gate, never a rollup —
        // always scoped to the signed-in user regardless of role. See App.tsx.
        useShiftStore.getState().loadShift(useAuthStore.getState().activeUser?.id);
        // The console's reconciliation view reads every shift, so refresh that too.
        useShiftStore.getState().loadShiftHistory();
        break;
      case 'expenses':
        useExpenseStore.getState().loadExpenses(undefined, scopedUserId());
        break;
      case 'users':
        useAuthStore.getState().loadUsers();
        break;
      case 'audit_logs':
        useAuditStore.getState().loadAuditLogs();
        break;
    }
  }, RELOAD_DEBOUNCE_MS);
}

function handleRealtimeChange(pgTable: SyncablePgTable, payload: any): void {
  const raw = payload.eventType === 'DELETE' ? payload.old : payload.new;
  if (!raw) return;
  const camelRow = toCamelCase(raw);
  applyRemoteRow(pgTable, camelRow, payload.eventType)
    .then((changed) => {
      if (changed) scheduleStoreReload(pgTable);
    })
    .catch((e) => console.warn(`[realtimeSync] failed to apply ${pgTable} change:`, e));
}

/** Pulls every row belonging to this account from all five syncable tables and merges
 *  them in. Additive/merge-only — never deletes a local row just because a page didn't
 *  include it. Returns true if any table actually received a change, so callers (e.g. a
 *  first-time login on a new device) can tell whether anything was really pulled down. */
export async function runReconciliationPull(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;

  // Gate on the actual Supabase session, not the local Zustand `isAuthenticated` flag —
  // this is called during first-time device adoption (adoptAccountFromCloud) at the
  // moment a session has just been established but before local state catches up, so
  // the Zustand flag would still read false there and wrongly block the very first pull.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) return false;

  const accountId = await getAccountId();
  if (!accountId) return false;

  let changedOverall = false;

  for (const pgTable of SYNCABLE_TABLES) {
    try {
      // Every table now carries account_id, expenses included — so all five filter the
      // same way. RLS enforces the same boundary server-side; this just avoids pulling
      // rows the policy would reject anyway.
      const { data, error } = await supabase.from(pgTable).select('*').eq('account_id', accountId);

      if (error || !data) {
        console.warn(`[realtimeSync] reconciliation pull failed for ${pgTable}:`, error?.message);
        continue;
      }

      let changedAny = false;
      for (const row of data) {
        const changed = await applyRemoteRow(pgTable, toCamelCase(row), 'UPDATE');
        if (changed) changedAny = true;
      }
      if (changedAny) {
        scheduleStoreReload(pgTable);
        changedOverall = true;
      }
    } catch (e) {
      console.warn(`[realtimeSync] reconciliation pull threw for ${pgTable}:`, e);
    }
  }

  // Business settings follow the account too, so pull them on the same pass. Kept
  // separate from the loop above because account_settings is keyed by account_id and
  // holds one JSONB row, not id-keyed domain records.
  try {
    const { data, error } = await supabase
      .from('account_settings')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (!error && data) {
      const applied = await applyRemoteSettings(toCamelCase(data));
      if (applied) {
        await useDeviceStore.getState().loadConfig();
        changedOverall = true;
      }
    }
  } catch (e) {
    console.warn('[realtimeSync] settings pull failed:', e);
  }

  return changedOverall;
}

/**
 * Full two-way catch-up, to be run whenever this device (re)gains a cloud session:
 * on login, on reconnect, and on the periodic safety net.
 *
 * Order matters. Stamping comes first: rows created before account scoping existed carry
 * no accountId, and the cloud would reject every one of them, so they must be claimed by
 * the signed-in account before anything tries to upload them. Reviving the outbox next
 * clears any backoff left over from the disconnected stretch, so the backfill sweep sees
 * an accurate picture of what is genuinely still owed. Backfill then queues anything the
 * cloud never received, and only then do we pull down — so a device holding the sole copy
 * of some history uploads it before it starts merging remote state on top of its own.
 */
export async function runCloudCatchUp(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) return false;

  try {
    const accountId = await getAccountId();
    if (accountId) await stampLocalRowsWithAccount(accountId);

    const revived = await dbService.revivePendingOutbox();
    if (revived) {
      console.info(`[realtimeSync] revived ${revived} outbox row(s) that were parked as failed`);
    }
    const queued = await runBackfillPush();
    if (revived || queued) {
      // Push immediately rather than waiting for the next 15s poll.
      await useSyncStore.getState().checkOutbox();
      await useSyncStore.getState().triggerSyncWorker();
    }
  } catch (e) {
    console.warn('[realtimeSync] upward catch-up failed:', e);
  }

  return runReconciliationPull();
}

/** Opens one realtime channel covering all five syncable tables, plus the reconnect/
 *  periodic reconciliation net. Idempotent — safe to call on every login. */
export function startRealtimeSync(): void {
  if (!isSupabaseConfigured || typeof window === 'undefined') return;
  if ((globalThis as any)._realtimeSyncStarted) return;
  (globalThis as any)._realtimeSyncStarted = true;

  (async () => {
    const accountId = await getAccountId();
    if (!accountId) {
      // No session yet — nothing to subscribe as. Login calls this again once there is.
      (globalThis as any)._realtimeSyncStarted = false;
      return;
    }

    // Every table filters on account_id, expenses included — it no longer has to lean on
    // RLS alone the way it did when it was scoped through a shift_id subquery.
    const scope = `account_id=eq.${accountId}`;
    channel = supabase
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: scope }, (p) => handleRealtimeChange('tickets', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts', filter: scope }, (p) => handleRealtimeChange('shifts', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users', filter: scope }, (p) => handleRealtimeChange('users', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_logs', filter: scope }, (p) => handleRealtimeChange('audit_logs', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: scope }, (p) => handleRealtimeChange('expenses', p))
      .subscribe();

    await runCloudCatchUp();
  })();

  if (!onlineListenerAttached) {
    onlineListenerAttached = true;
    window.addEventListener('online', () => {
      runCloudCatchUp().catch(() => {});
    });
  }

  if (!reconciliationInterval) {
    reconciliationInterval = setInterval(() => {
      runCloudCatchUp().catch(() => {});
    }, RECONCILIATION_INTERVAL_MS);
  }
}

/** Tears the channel and timers down. Call on logout so a signed-out session doesn't
 *  keep pulling/receiving data it no longer has an authenticated right to see. */
export function stopRealtimeSync(): void {
  (globalThis as any)._realtimeSyncStarted = false;
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }
}
