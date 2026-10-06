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
import { selectSnapshotPages } from '../supabase/pagedSelect';
import { toCamelCase } from '../../utils/caseMapping';
import { applyRemoteRow, applyRemoteSettings, applyRemoteRows, SyncablePgTable } from './remoteMerge';
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
import { useServerSalesStore } from '../../store/useServerSalesStore';
import { useAuditStore } from '../../store/useAuditStore';
import { useWorkforceStore } from '../../store/useWorkforceStore';
import { useInventoryStore } from '../../store/useInventoryStore';

const DEVICE_CONFIG_KEY = 'device_config';
/** Visible devices reconcile every 30 seconds even if realtime is unavailable.
 * Focus, network restoration and websocket resubscription also refresh immediately. */
const RECONCILIATION_INTERVAL_MS = 30_000;
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

const SYNCABLE_TABLES: SyncablePgTable[] = [
  'audit_logs',
  'users',
  'tickets',
  'shifts',
  'expenses',
  'server_sales',
  'role_pay_configs',
  'staff_assessments',
  'wage_ledger',
  'inventory_items',
  'inventory_batches',
  'inventory_movements',
];

let channel: ReturnType<typeof supabase.channel> | null = null;
let reconciliationInterval: ReturnType<typeof setInterval> | null = null;
let lifecycle = 0;
let wakeListener: (() => void) | null = null;
let onlineListener: (() => void) | null = null;
const reloadTimers: Partial<Record<SyncablePgTable, ReturnType<typeof setTimeout>>> = {};
let ticketHistoryChanged = false;

/** Reload the currently selected store scope: personal recent till history or
 * account-wide console reporting. A remote event never widens a till's scope. */

function scheduleStoreReload(pgTable: SyncablePgTable, currentPreview = false): void {
  // Hydrating N historical pages must not reread/sort the whole growing report
  // N times. Current-trading previews still refresh while history is in flight;
  // the complete report refreshes once the pass finishes, including on errors.
  if (pgTable === 'tickets' && !useTicketStore.getState().scope && useSyncStore.getState().isPulling && !currentPreview) {
    ticketHistoryChanged = true;
    return;
  }
  // Throttle, rather than postponing forever during a continuous stream of pages.
  if (reloadTimers[pgTable]) return;
  reloadTimers[pgTable] = setTimeout(() => {
    delete reloadTimers[pgTable];
    switch (pgTable) {
      case 'tickets':
        useTicketStore.getState().loadTickets(useTicketStore.getState().scope);
        break;
      case 'shifts':
        // currentShift is a personal "is my shift open" gate, never a rollup —
        // always scoped to the signed-in user regardless of role. See App.tsx.
        if (useAuthStore.getState().activeUser?.role !== 'admin') {
          useShiftStore.getState().loadShift(useAuthStore.getState().activeUser?.id);
        }
        // The console's reconciliation view reads every shift, so refresh that too.
        useShiftStore.getState().loadShiftHistory();
        break;
      case 'expenses':
        useExpenseStore.getState().loadExpenses(useExpenseStore.getState().scope.shiftId, useExpenseStore.getState().scope.userId);
        break;
      case 'server_sales':
        // Account-wide, never scoped to the signed-in user: these are entered by a manager
        // about somebody else, so "my own" would show an empty screen to the only person
        // who ever looks at it.
        useServerSalesStore.getState().loadServerSales();
        break;
      case 'role_pay_configs':
      case 'staff_assessments':
      case 'wage_ledger':
        useWorkforceStore.getState().load();
        break;
      case 'inventory_items':
      case 'inventory_batches':
      case 'inventory_movements':
        useInventoryStore.getState().load();
        break;
      case 'users':
        useAuthStore.getState().loadUsers();
        break;
      case 'audit_logs':
        useAuthStore.getState().loadUsers();
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
type PullOptions = { full?: boolean; lookBackMs?: number; recentFirst?: boolean };
let pullFlight: Promise<boolean> | null = null;
let previewFlight: Promise<void> | null = null;
/** Continue refreshing current trading even while a new device downloads years
 * of history. Preview positions are ephemeral and never skip the history pass. */
const previewPositions: Partial<Record<'tickets' | 'shifts', string>> = {};
let previewAccount: string | null = null;
function refreshCurrentTrading(): Promise<void> {
  if (previewFlight) return previewFlight;
  const generation = lifecycle;
  const flight = (async () => {
    const accountId = await getAccountId();
    if (!accountId) return;
    if (previewAccount !== accountId) {
      delete previewPositions.tickets; delete previewPositions.shifts;
      previewAccount = accountId;
    }
    const recent = new Date(Date.now() - DEEP_SWEEP_LOOKBACK_MS).toISOString();
    for (const table of ['tickets', 'shifts'] as const) {
      let newest = '';
      try {
        const since = previewPositions[table]
          ? new Date(Date.parse(previewPositions[table]!) - 120_000).toISOString() : recent;
        // This is a bounded preview, not the durable history cursor. Newest first
        // means today's latest sale need not wait behind 30,000 earlier sales.
        const { data, error } = await supabase.from(table).select('*').eq('account_id', accountId)
          .gte('updated_at', since).order('updated_at', { ascending: false })
          .order('id', { ascending: false }).range(0, 499);
        if (error) throw error;
        if (generation !== lifecycle || await getAccountId() !== accountId) return;
        const page = data ?? [];
        if (await applyRemoteRows(table, page.map(row => toCamelCase(row)))) scheduleStoreReload(table, true);
        for (const row of page) if (Date.parse(row.updated_at) > (Date.parse(newest) || 0)) newest = row.updated_at;
        if (generation === lifecycle && newest) previewPositions[table] = newest;
      } catch (e) { console.warn(`[realtimeSync] ongoing ${table} refresh failed:`, e); }
    }
  })().finally(() => { if (previewFlight === flight) previewFlight = null; });
  previewFlight = flight;
  return flight;
}
export function runReconciliationPull(opts: PullOptions = {}): Promise<boolean> {
  if (pullFlight) {
    if (opts.recentFirst) void refreshCurrentTrading().catch(() => {});
    return pullFlight;
  }
  const flight = reconcile(opts).finally(() => {
    if (pullFlight === flight) pullFlight = null;
  });
  pullFlight = flight;
  return flight;
}

async function reconcile(
  opts: PullOptions
): Promise<boolean> {
  const generation = lifecycle;
  if (!isSupabaseConfigured) return false;

  // Gate on the actual Supabase session, not the local Zustand `isAuthenticated` flag —
  // this is called during first-time device adoption (adoptAccountFromCloud) at the
  // moment a session has just been established but before local state catches up, so
  // the Zustand flag would still read false there and wrongly block the very first pull.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) return false;

  const accountId = await getAccountId();
  if (!accountId) return false;
  const stillCurrent = async () => generation === lifecycle && await getAccountId() === accountId;
  if (!await stillCurrent()) return false;

  let changedOverall = false;
  const errors: string[] = [];
  useSyncStore.setState({ isPulling: true, pullError: null });

  // A new phone or one several days behind renders current trading first. This
  // preview never advances a watermark: the history pass below must finish first.
  if (opts.recentFirst) {
    await refreshCurrentTrading();
    if (!await stillCurrent()) return false;
  }

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
      let changedAny = false;
      let newest = '';
      for await (const page of selectSnapshotPages(() => {
        const query = supabase.from(pgTable).select('*').eq('account_id', accountId);
        return since ? query.gte('updated_at', since) : query;
      })) {
        if (!await stillCurrent()) return false;
        changedAny = await applyRemoteRows(pgTable, page.map(row => toCamelCase(row))) || changedAny;
        if (changedAny) scheduleStoreReload(pgTable);
        for (const row of page) {
          const stamp = String(row.updated_at ?? '');
          if (Date.parse(stamp) > (Date.parse(newest) || 0)) newest = stamp;
        }
      }

      // Only ever advanced after the rows it covers have actually been applied, so a
      // failure part-way through re-reads them next time rather than skipping them.
      if (!await stillCurrent()) return false;
      if (newest) await advanceWatermark(accountId, pgTable, newest);

      if (changedAny) {
        scheduleStoreReload(pgTable);
        changedOverall = true;
      }
    } catch (e) {
      errors.push(`${pgTable}: ${(e as any)?.message ?? String(e)}`);
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

    if (!await stillCurrent()) return false;
    if (error) errors.push(`account_settings: ${error.message}`);
    if (!error && data) {
      const applied = await applyRemoteSettings(toCamelCase(data));
      if (applied) {
        await useDeviceStore.getState().loadConfig();
        changedOverall = true;
      }
    }
  } catch (e) {
    errors.push(`account_settings: ${e instanceof Error ? e.message : String(e)}`);
    console.warn('[realtimeSync] settings pull failed:', e);
  }

  if (await stillCurrent()) useSyncStore.setState({
    isPulling: false,
    pullError: errors.length ? errors.join('\n') : null,
    ...(!errors.length ? { lastPulledAt: new Date().toISOString() } : {}),
  });
  if (await stillCurrent() && ticketHistoryChanged) {
    ticketHistoryChanged = false;
    scheduleStoreReload('tickets');
  }
  return changedOverall;
}

/**
 * Full two-way catch-up, to be run whenever this device (re)gains a cloud session:
 * on login, on reconnect, and on the periodic safety net.
 *
 * Send already-queued work before doing expensive historical comparisons. Queue
 * entries are stamped when sent; older domain rows are stamped in bounded chunks
 * before deep backfill. Pulls then merge without overwriting unsent local mutations.
 */
let upwardFlight: Promise<void> | null = null;
let reviveRequested = false;

async function catchUpUploads(): Promise<void> {
  const generation = lifecycle;
  try {
    await useSyncStore.getState().checkOutbox();
    await useSyncStore.getState().triggerSyncWorker();
    if (generation !== lifecycle) return;
    if (reviveRequested) {
      reviveRequested = false;
      await dbService.revivePendingOutbox();
      await useSyncStore.getState().triggerSyncWorker();
      if (generation !== lifecycle) return;
    }
    if (Date.now() - lastDeepSweep >= DEEP_SWEEP_EVERY_MS) {
      const accountId = await getAccountId();
      if (accountId) {
        await stampLocalRowsWithAccount(accountId);
        if (await runBackfillPush()) await useSyncStore.getState().triggerSyncWorker();
        lastDeepSweep = Date.now();
      }
    }
  } catch (e) { console.warn('[realtimeSync] upward catch-up failed:', e); }
}

/** Current trading reads never wait for this device's upload/backfill backlog. */
export function runCloudCatchUp(opts: { revive?: boolean } = {}): Promise<boolean> {
  if (!isSupabaseConfigured) return Promise.resolve(false);
  const deep = Date.now() - lastDeepSweep >= DEEP_SWEEP_EVERY_MS;
  reviveRequested ||= Boolean(opts.revive);
  if (!upwardFlight) upwardFlight = catchUpUploads().finally(() => { upwardFlight = null; });
  return runReconciliationPull({ recentFirst: true, ...(deep ? { lookBackMs: DEEP_SWEEP_LOOKBACK_MS } : {}) });
}

/** Opens one realtime channel covering all five syncable tables, plus the reconnect/
 *  periodic reconciliation net. Idempotent — safe to call on every login. */
export function startRealtimeSync(): void {
  if (!isSupabaseConfigured || typeof window === 'undefined') return;
  if ((globalThis as any)._realtimeSyncStarted) return;
  (globalThis as any)._realtimeSyncStarted = true;

  const generation = ++lifecycle;
  (async () => {
    const accountId = await getAccountId();
    if (generation !== lifecycle) return;
    if (!accountId) {
      // No session yet — nothing to subscribe as. Login calls this again once there is.
      stopRealtimeSync();
      return;
    }

    // Every table filters on account_id, expenses included — it no longer has to lean on
    // RLS alone the way it did when it was scoped through a shift_id subquery.
    const scope = `account_id=eq.${accountId}`;
    channel = supabase
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('tickets', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('shifts', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('users', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_logs', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('audit_logs', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('expenses', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'server_sales', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('server_sales', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'role_pay_configs', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('role_pay_configs', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_assessments', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('staff_assessments', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wage_ledger', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('wage_ledger', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_items', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('inventory_items', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_batches', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('inventory_batches', p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_movements', filter: scope }, (p) => { if (generation === lifecycle) handleRealtimeChange('inventory_movements', p); })
      .subscribe(status => {
        if (generation !== lifecycle) return;
        useSyncStore.setState({ realtimeConnected: status === 'SUBSCRIBED' });
        if (status === 'SUBSCRIBED') void runReconciliationPull({ recentFirst: true });
      });

    await runCloudCatchUp({ revive: true });
  })().catch(e => {
    if (generation === lifecycle) {
      stopRealtimeSync();
      useSyncStore.setState({ pullError: String(e) });
    }
  });

  wakeListener = () => {
    if (document.visibilityState === 'hidden' || !navigator.onLine) return;
    void runCloudCatchUp().catch(() => {});
  };
  onlineListener = () => { void runCloudCatchUp({ revive: true }).catch(() => {}); };
  window.addEventListener('online', onlineListener);
  window.addEventListener('focus', wakeListener);
  document.addEventListener('visibilitychange', wakeListener);
  reconciliationInterval = setInterval(() => {
    if (document.visibilityState !== 'hidden' && navigator.onLine) void runReconciliationPull({ recentFirst: true }).catch(() => {});
  }, RECONCILIATION_INTERVAL_MS);
}

/** Tears the channel and timers down. Call on logout so a signed-out session doesn't
 *  keep pulling/receiving data it no longer has an authenticated right to see. */
export function stopRealtimeSync(): void {
  (globalThis as any)._realtimeSyncStarted = false;
  lifecycle++;
  pullFlight = null;
  previewFlight = null;
  previewAccount = null;
  delete previewPositions.tickets;
  delete previewPositions.shifts;
  lastDeepSweep = 0;
  ticketHistoryChanged = false;
  useSyncStore.setState({ isPulling: false, realtimeConnected: false, lastPulledAt: undefined, pullError: null });
  if (onlineListener) window.removeEventListener('online', onlineListener);
  if (wakeListener) {
    window.removeEventListener('focus', wakeListener);
    document.removeEventListener('visibilitychange', wakeListener);
  }
  onlineListener = wakeListener = null;
  for (const table of SYNCABLE_TABLES) {
    clearTimeout(reloadTimers[table]);
    delete reloadTimers[table];
  }
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }
}
