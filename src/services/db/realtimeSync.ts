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
import { selectAllPages } from '../supabase/pagedSelect';
import { toCamelCase } from '../../utils/caseMapping';
import { applyRemoteRow, applyRemoteSettings, loadDirtyIds, SyncablePgTable } from './remoteMerge';
import { useDeviceStore } from '../../store/useDeviceStore';
import { runBackfillPush } from './cloudBackfill';
import { getAccountId, stampLocalRowsWithAccount } from './accountScope';
import { watermarkFor, advanceWatermark } from './syncWatermarks';
import { dbService } from './IndexedDbService';
import { db } from './dexieSchema';
import { useSyncStore } from '../../store/useSyncStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useExpenseStore } from '../../store/useExpenseStore';
import { useAuditStore } from '../../store/useAuditStore';

const DEVICE_CONFIG_KEY = 'device_config';
/**
 * How often the safety-net pull runs.
 *
 * This is not how fast changes travel — realtime delivers those within a second, and the
 * sync badge pushes every local write the moment it is made. This timer only exists to
 * catch what a dropped websocket missed, so it is a backstop, not the mechanism. At 60
 * seconds it was 1,440 rounds of five requests per till per day; a till left running
 * overnight spent the night asking. Five minutes cuts that by 80% and costs nothing that
 * anyone standing at a till can perceive — and the sync badge now pulls as well as pushes,
 * so the one case where a person is actively waiting has a button that answers it.
 */
const RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const RELOAD_DEBOUNCE_MS = 150;

/**
 * How often the deep sweep runs: the id-by-id diff against the cloud, plus a pull that
 * deliberately reaches back behind this device's own position. See runCloudCatchUp.
 */
const DEEP_SWEEP_EVERY_MS = 6 * 60 * 60_000;

/**
 * How far behind its position the deep sweep re-reads.
 *
 * The safety net for the one thing an incremental pull cannot notice on its own: a row
 * that was somehow not applied while the position moved past it. A day is long enough to
 * cover any realistic gap and short enough to stay cheap — a full re-read of the account's
 * whole history would be back to costing more per sweep than a month's transfer allowance.
 */
const DEEP_SWEEP_LOOKBACK_MS = 24 * 60 * 60_000;

let lastDeepSweep = 0;

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

/**
 * Where a table's read should start: this device's stored position, or further back still
 * if the caller asked to look behind it. Null means "no position — read everything".
 *
 * The look-back floor is measured on the local clock, which is fine because it can only
 * ever widen the window: the stored position is the thing that governs what must not be
 * skipped, and it is only ever a value the server stamped.
 */
async function pullFrom(
  accountId: string,
  pgTable: SyncablePgTable,
  lookBackMs?: number
): Promise<string | null> {
  const mark = await watermarkFor(accountId, pgTable);
  if (!mark || !lookBackMs) return mark;

  const floor = new Date(Date.now() - lookBackMs).toISOString();
  return floor < mark ? floor : mark;
}

/** Pulls this account's rows from all five syncable tables and merges them in.
 *  Additive/merge-only — never deletes a local row just because a page didn't include it.
 *  Returns true if any table actually received a change, so callers (e.g. a first-time
 *  login on a new device) can tell whether anything was really pulled down.
 *
 *  Incremental by default: each table is read from where this device left off (see
 *  syncWatermarks). `full` forces the whole history — the first pull on a device has that
 *  anyway, since it has no position stored yet. `lookBackMs` widens the window behind
 *  that position without going all the way back, for the periodic deep sweep. */
export async function runReconciliationPull(
  opts: { full?: boolean; lookBackMs?: number } = {}
): Promise<boolean> {
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
      // Where this device got to last time. Null on a fresh device, after a restore, or
      // when `full` is asked for — all of which mean "read the lot".
      const since = opts.full ? null : await pullFrom(accountId, pgTable, opts.lookBackMs);

      // Every table now carries account_id, expenses included — so all five filter the
      // same way. RLS enforces the same boundary server-side; this just avoids pulling
      // rows the policy would reject anyway.
      //
      // Paged: an unpaged select silently stops at the project's "Max rows" cap, so an
      // account with more history than that could never hand a till the rest of it.
      const { data, error } = await selectAllPages(() => {
        const query = supabase.from(pgTable).select('*').eq('account_id', accountId);
        return since ? query.gte('updated_at', since) : query;
      });

      if (error || !data) {
        console.warn(`[realtimeSync] reconciliation pull failed for ${pgTable}:`, error?.message);
        continue;
      }

      // One indexed read for the whole table, rather than a full outbox walk per row.
      const dirtyIds = await loadDirtyIds(pgTable);

      let changedAny = false;
      let newest = '';
      for (const row of data) {
        const stamp = String((row as any).updated_at ?? '');
        if (stamp > newest) newest = stamp;
        const changed = await applyRemoteRow(pgTable, toCamelCase(row), 'UPDATE', dirtyIds);
        if (changed) changedAny = true;
      }

      // Only ever advanced after the rows it covers have actually been applied, so a
      // failure part-way through re-reads them next time rather than skipping them.
      if (newest) await advanceWatermark(accountId, pgTable, newest);

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
export async function runCloudCatchUp(opts: { revive?: boolean } = {}): Promise<boolean> {
  if (!isSupabaseConfigured) return false;

  // Reviving means "clear every backoff and try the lot again", which is right when
  // something has actually changed — a sign-in, the network returning, a person pressing
  // sync. On the periodic tick it was wrong: it reset every rejected row's retry count
  // once a minute, so nothing ever aged into a longer backoff or showed up as stuck, and
  // a queue the cloud was refusing was re-sent in full every 60 seconds forever. That is
  // the churn behind "hundreds of operations, barely moving".
  const { revive = false } = opts;

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) return false;

  // The expensive half of this sweep — comparing every local id against the cloud's, and
  // reaching back behind what this device has already read — is a safety net, not the
  // mechanism. Every ordinary write is pushed the instant it is queued, and every remote
  // change arrives by realtime or on the next minute's incremental pull; this exists only
  // to catch what those missed.
  //
  // It used to run every minute, and it re-read the account's entire history each time.
  // For a restaurant doing 3,000 tickets a day that is ~100 MB per till per minute to
  // learn nothing — more than a month's transfer allowance every hour. Now it runs when
  // something has actually changed (a sign-in, the network returning) and every six hours
  // otherwise, and even then it looks back a day rather than for ever.
  const deep = revive || Date.now() - lastDeepSweep >= DEEP_SWEEP_EVERY_MS;
  if (deep) lastDeepSweep = Date.now();

  try {
    const accountId = await getAccountId();
    if (accountId) await stampLocalRowsWithAccount(accountId);

    const revived = revive ? await dbService.revivePendingOutbox() : 0;
    if (revived) {
      console.info(`[realtimeSync] revived ${revived} outbox row(s) that were parked as failed`);
    }
    const queued = deep ? await runBackfillPush() : 0;
    if (revive || queued) {
      // Push immediately rather than waiting for the next poll.
      await useSyncStore.getState().checkOutbox();
      await useSyncStore.getState().triggerSyncWorker();
    }
  } catch (e) {
    console.warn('[realtimeSync] upward catch-up failed:', e);
  }

  // Note that even a revive pulls incrementally. A device that was offline for three days
  // resumes from its own stored position and gets exactly the three days it missed —
  // re-reading the whole history would cost the same whether it had missed a minute or a
  // year, which is precisely the behaviour that made a flaky connection expensive.
  return runReconciliationPull(deep ? { lookBackMs: DEEP_SWEEP_LOOKBACK_MS } : {});
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

    await runCloudCatchUp({ revive: true });
  })();

  if (!onlineListenerAttached) {
    onlineListenerAttached = true;
    window.addEventListener('online', () => {
      runCloudCatchUp({ revive: true }).catch(() => {});
    });
  }

  if (!reconciliationInterval) {
    reconciliationInterval = setInterval(() => {
      runCloudCatchUp().catch(() => {});
    }, RECONCILIATION_INTERVAL_MS);
    // Deliberately no revive here — see runCloudCatchUp.
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
