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
import { applyRemoteRow, SyncablePgTable } from './remoteMerge';
import { runBackfillPush } from './cloudBackfill';
import { dbService } from './IndexedDbService';
import { db } from './dexieSchema';
import { useSyncStore } from '../../store/useSyncStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useExpenseStore } from '../../store/useExpenseStore';

const DEVICE_CONFIG_KEY = 'device_config';
const RECONCILIATION_INTERVAL_MS = 60_000;
const RELOAD_DEBOUNCE_MS = 150;

const SYNCABLE_TABLES: SyncablePgTable[] = ['users', 'tickets', 'shifts', 'expenses', 'audit_logs'];

let channel: ReturnType<typeof supabase.channel> | null = null;
let reconciliationInterval: ReturnType<typeof setInterval> | null = null;
let onlineListenerAttached = false;
const reloadTimers: Partial<Record<SyncablePgTable, ReturnType<typeof setTimeout>>> = {};

/** Same location resolution used everywhere else in the app: the signed-in account's
 *  cloud location first (an admin's identity is the source of truth for which location
 *  they belong to), falling back to this device's local config. */
async function resolveEffectiveLocationId(): Promise<string> {
  if (isSupabaseConfigured) {
    try {
      const { data } = await supabase.auth.getUser();
      const meta = (data?.user?.user_metadata ?? {}) as Record<string, unknown>;
      const loc = typeof meta.location_id === 'string' ? meta.location_id.trim() : '';
      if (loc) return loc;
    } catch (_) {
      // offline or no session — fall back to local config below
    }
  }
  const cfg = await db.config.get(DEVICE_CONFIG_KEY);
  return cfg?.value?.locationId || 'LOC01';
}

/** Tickets/expenses show a location-wide rollup for admins, but only "my own" for
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
        break;
      case 'expenses':
        useExpenseStore.getState().loadExpenses(undefined, scopedUserId());
        break;
      case 'users':
        useAuthStore.getState().loadUsers();
        break;
      case 'audit_logs':
        break; // nothing reads this back yet
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

/** Pulls every row for this location from all five syncable tables and merges them in.
 *  Additive/merge-only — never deletes a local row just because a page didn't include it.
 *  Returns true if any table actually received a change, so callers (e.g. a first-time
 *  login on a new device) can tell whether anything was really pulled down. */
export async function runReconciliationPull(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;

  // Gate on the actual Supabase session, not the local Zustand `isAuthenticated` flag —
  // this is called during first-time device adoption (adoptAccountFromCloud) at the
  // moment a session has just been established but before local state catches up, so
  // the Zustand flag would still read false there and wrongly block the very first pull.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) return false;

  const locationId = await resolveEffectiveLocationId();
  let changedOverall = false;

  for (const pgTable of SYNCABLE_TABLES) {
    try {
      // expenses has no location_id column of its own — it's scoped via a
      // shift_id -> shifts.location_id RLS subquery instead, so pull unfiltered.
      const query = supabase.from(pgTable).select('*');
      const { data, error } = pgTable === 'expenses' ? await query : await query.eq('location_id', locationId);

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

  return changedOverall;
}

/**
 * Full two-way catch-up, to be run whenever this device (re)gains a cloud session:
 * on login, on reconnect, and on the periodic safety net.
 *
 * Order matters. Reviving the outbox first clears any backoff left over from the
 * disconnected stretch, so the backfill sweep sees an accurate picture of what is
 * genuinely still owed. Backfill then queues anything the cloud never received, and
 * only then do we pull down — so a device holding the sole copy of some history
 * uploads it before it starts merging remote state on top of its own.
 */
export async function runCloudCatchUp(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) return false;

  try {
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
    const locationId = await resolveEffectiveLocationId();

    channel = supabase
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `location_id=eq.${locationId}` }, (p) => handleRealtimeChange('tickets', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts', filter: `location_id=eq.${locationId}` }, (p) => handleRealtimeChange('shifts', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users', filter: `location_id=eq.${locationId}` }, (p) => handleRealtimeChange('users', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_logs', filter: `location_id=eq.${locationId}` }, (p) => handleRealtimeChange('audit_logs', p))
      // expenses has no location_id column — RLS (shift_id -> shifts.location_id) is
      // the only scoping here, same as the reconciliation pull above.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses' }, (p) => handleRealtimeChange('expenses', p))
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
