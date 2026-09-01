import { create } from 'zustand';
import { SyncState, OutboxItem, SyncAction } from '../types/sync';
import { dbService } from '../services/db/IndexedDbService';
import { supabase, isSupabaseConfigured } from '../services/supabase/supabaseClient';
import { useDeviceStore } from './useDeviceStore';
import { toSnakeCase } from '../utils/caseMapping';
import { getAccountId } from '../services/db/accountScope';
import { restoreDeviceSession, isDeviceRevoked } from '../services/supabase/deviceIdentity';

interface SyncStoreState extends SyncState {
  pendingItems: OutboxItem[];
  checkOutbox: () => Promise<void>;
  triggerSyncWorker: () => Promise<void>;
  /**
   * What the manual sync button does: clear every backoff timer and push right now.
   *
   * The background worker deliberately backs a failed row off for up to half an hour, so
   * after any hiccup the queue drains in dribs — which is exactly what "sync now" is
   * being pressed to override. Someone standing at the till pressing the badge is new
   * information ("the connection is good, try again"), so honour it rather than making
   * them watch a timer they cannot see.
   */
  forceSyncNow: () => Promise<void>;
  startBackgroundLoop: () => void;
}

/**
 * Rows per cloud request. The worker used to send one row per HTTP round trip, strictly
 * sequentially: a 300-row backlog meant 300 round trips, so the pending counter visibly
 * ticked down one at a time for minutes on a normal connection. Postgres takes an array
 * just as happily as a single row, so the same backlog is now a couple of requests.
 */
const MAX_BATCH_ROWS = 200;

interface OutboxBatch {
  tableName: string;
  action: SyncAction;
  items: OutboxItem[];
}

/**
 * Split the due queue into runs that can be sent as one request each.
 *
 * Runs are **contiguous**, not merely grouped by table: the queue is ordered by createdAt
 * and that order carries meaning. Sorting all the UPDATEs together and all the DELETEs
 * together would let a record's later deletion be sent before its earlier update, and the
 * update would then recreate the row that was just removed.
 *
 * Exported for testing — the ordering guarantee is the whole correctness argument for
 * batching, so it is pinned down directly rather than inferred from the worker's output.
 */
export function batchOutbox(items: OutboxItem[], maxRows: number = MAX_BATCH_ROWS): OutboxBatch[] {
  const batches: OutboxBatch[] = [];

  for (const item of items) {
    const current = batches[batches.length - 1];
    const extendsRun =
      current &&
      current.tableName === item.tableName &&
      current.action === item.action &&
      current.items.length < maxRows;

    if (extendsRun) current.items.push(item);
    else batches.push({ tableName: item.tableName, action: item.action, items: [item] });
  }

  return batches;
}

/**
 * Collapse repeat writes to the same record within one batch.
 *
 * Two queued snapshots of the same row are two versions of the same full record, so the
 * later one wins and the earlier is already accounted for. This is not just an
 * optimisation: Postgres rejects an ON CONFLICT upsert whose payload touches the same row
 * twice ("cannot affect row a second time"), which would fail the entire batch over
 * something that is not an error at all.
 */
export function dedupeBatch(items: OutboxItem[]): { send: OutboxItem[]; superseded: OutboxItem[] } {
  // Index of the last queued write per record id. A row with no id at all can't be
  // deduped (or conflict-resolved by the cloud), so it is always sent as-is.
  const lastIndexFor = new Map<string, number>();
  items.forEach((item, i) => {
    const rowId = item.payload?.id;
    if (rowId !== undefined && rowId !== null) lastIndexFor.set(String(rowId), i);
  });

  const send: OutboxItem[] = [];
  const superseded: OutboxItem[] = [];

  items.forEach((item, i) => {
    const rowId = item.payload?.id;
    if (rowId === undefined || rowId === null) send.push(item);
    else if (lastIndexFor.get(String(rowId)) === i) send.push(item);
    else superseded.push(item);
  });

  return { send, superseded };
}

/**
 * Errors that unambiguously mean "this browser is not authenticated" — no session or a
 * dead JWT. These must never count against a row's retry budget: the row is fine, the
 * till just isn't signed in, and charging it for that is exactly how a couple of
 * cloud-less minutes used to orphan a day of tickets permanently.
 */
function isSessionFailure(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  const msg = String(error.message ?? '').toLowerCase();
  return (
    code === 'PGRST301' || // JWT expired or invalid
    code === '401' ||
    msg.includes('jwt') ||
    msg.includes('not authenticated') ||
    msg.includes('unauthorized')
  );
}

/**
 * An RLS violation is ambiguous and must not be read as "the session died".
 *
 * Postgres returns the identical 42501 for two completely different situations: an
 * unauthenticated caller, and a perfectly authenticated caller pushing a row scoped to
 * a tenant its token doesn't cover (a shift stamped LOC01 against a token carrying a
 * different location_id, or none at all). Only checking the live session tells them
 * apart — treating every 42501 as a lost session made a successful reconnect flip
 * straight back to "Not Signed In to Cloud" on the first mis-scoped row.
 */
function isRlsViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    String(error.code ?? '') === '42501' ||
    String(error.message ?? '').toLowerCase().includes('row-level security')
  );
}

/**
 * Whether this browser holds a real Supabase session — restoring the till's own one if
 * it does not.
 *
 * A till is enrolled with its account in its own right, so a lost session is something
 * the device can fix by itself. Doing it here means the fix happens on the path that
 * actually noticed the problem, rather than waiting for an owner to walk over with a PIN.
 */
async function hasCloudSession(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session) return true;
    return await restoreDeviceSession();
  } catch (_) {
    return false;
  }
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  cloudConnected: false,
  cloudError: null,
  pendingCount: 0,
  stuckCount: 0,
  isSyncing: false,
  pendingItems: [],
  lastSyncedAt: undefined,

  checkOutbox: async () => {
    await dbService.init();
    const pending = await dbService.getPendingOutbox();
    // Report everything still owed to the cloud, not just what is due for a retry right
    // now, so a row waiting out a backoff can never be displayed as "synced".
    const { total, stuck } = await dbService.countUnsyncedOutbox();
    set({
      pendingCount: total,
      stuckCount: stuck,
      pendingItems: pending,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      cloudConnected: await hasCloudSession(),
    });

    // Automatically trigger self-contained background polling loop
    get().startBackgroundLoop();
  },

  triggerSyncWorker: async () => {
    if (get().isSyncing || get().pendingCount === 0) return;
    
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    if (!isOnline || !isSupabaseConfigured) {
      console.debug('[Sync Store] Worker skipped: offline or Supabase not configured');
      return;
    }

    // Being online is not the same as being authenticated. Without a Supabase session
    // every upsert below is rejected by RLS, and those rejections are not the queued
    // rows' fault — so skip entirely, exactly as if offline, rather than pushing every
    // row a step closer to being written off. hasCloudSession restores the till's own
    // session first, so reaching this branch means the device is not enrolled at all
    // (or cannot reach the cloud to prove it), which is the one case still needing a
    // person.
    if (!(await hasCloudSession())) {
      set({
        cloudConnected: false,
        cloudError:
          get().cloudError ??
          'This till has no cloud session and is not enrolled with your account, so nothing can reach your other devices. Your work is queued safely — an admin signing in here with their PIN will enrol it, once and for good.',
      });
      console.debug('[Sync Store] Worker skipped: no cloud session (data stays queued)');
      return;
    }

    set({ isSyncing: true, cloudConnected: true, cloudError: null });

    try {
      const items = await dbService.getPendingOutbox();
      const locationId = useDeviceStore.getState().config.locationId || 'LOC01';
      // The tenant key every RLS policy checks. Resolved once per batch rather than per
      // row, and never cached across batches, so a different account signing in on this
      // device can't push under the previous one's id.
      const accountId = await getAccountId();

      /** One row, prepared for the cloud's column names and tenant scoping. */
      const toCloudRow = (item: OutboxItem) => {
        const supabasePayload = toSnakeCase(item.payload);

        // Every synced row is owned by an account — this is what the RLS policies
        // compare against auth.uid(). Applied uniformly rather than per-table.
        if (accountId) supabasePayload.account_id = accountId;

        // location_id is descriptive now, not security-relevant, but audit_logs and
        // users have no locationId of their own to carry, so still supply it.
        if (item.tableName === 'users' || item.tableName === 'audit_logs') {
          supabasePayload.location_id = locationId;
        }
        return supabasePayload;
      };

      /**
       * Send one run of same-table, same-action rows as a single request.
       *
       * Removals have to be sent as removals. This branch used to be absent — every
       * queued row was upserted regardless of its action — so a DELETE would have
       * written the row straight back into the cloud instead of taking it out. Scoped by
       * account_id as well as id so a malformed queue entry can never reach beyond this
       * tenant.
       */
      const push = async (batch: OutboxBatch, rows: OutboxItem[]) => {
        if (batch.action === 'DELETE') {
          return supabase
            .from(batch.tableName)
            .delete()
            .in('id', rows.map((r) => r.payload.id))
            .eq('account_id', accountId ?? '');
        }
        // account_settings is keyed by account_id (one row per account), every other
        // table by the client-generated row id.
        const conflictKey = batch.tableName === 'account_settings' ? 'account_id' : 'id';
        return supabase
          .from(batch.tableName)
          .upsert(rows.map(toCloudRow), { onConflict: conflictKey });
      };

      /**
       * Whether to abandon the whole pass. An RLS rejection only means "signed out" if
       * the session really is gone; otherwise it is the row's scope that is wrong, and
       * saying so is more useful than blaming the credentials.
       */
      const classify = async (error: { code?: string; message?: string }, tableName: string) => {
        if (isSessionFailure(error) || (isRlsViolation(error) && !(await hasCloudSession()))) {
          console.warn(
            '[Sync Store] Cloud authorisation lost mid-sync; queue left intact:',
            error.message
          );
          set({
            isSyncing: false,
            cloudConnected: false,
            cloudError: `The cloud rejected this till's credentials (${error.message}). Your work is queued safely — reconnect with the admin PIN to send it.`,
          });
          return 'session-lost' as const;
        }
        if (isRlsViolation(error)) {
          // A revoked till authenticates perfectly well and simply matches no rows any
          // more, so this is by far the likeliest reason a healthy session is refused.
          // Saying "scoped to a different location" there would send whoever reads it
          // hunting through device settings for a problem that does not exist.
          set({
            cloudError: (await isDeviceRevoked())
              ? "This till's access to the account was revoked, so the cloud is refusing its records. Your work stays queued safely here. An admin can re-enable this till, or sign in on it with their PIN to enrol it again."
              : `Signed in, but the cloud is refusing this ${tableName} record because it is scoped to a different location than your account (${error.message}). It stays queued and will be retried.`,
          });
        }
        return 'row-fault' as const;
      };

      const fail = async (item: OutboxItem, reason: unknown) => {
        // One genuinely rejected record (schema mismatch, missing FK, etc.) must never
        // block every other queued ticket/shift/expense behind it. Back it off
        // exponentially and carry on — it keeps its place in the queue and is surfaced as
        // "stuck" rather than being dropped.
        console.error(
          `[Sync Store] Sync failed for ${item.tableName} record ${item.id} (attempt ${item.retryCount + 1}):`,
          reason
        );
        await dbService.markOutboxAttemptFailed(item.id, item.retryCount, String(reason));
      };

      for (const batch of batchOutbox(items)) {
        const { send, superseded } = dedupeBatch(batch.items);
        const { error } = await push(batch, send);

        if (!error) {
          // Superseded rows are acknowledged too: the record they described was sent, in
          // its newer form, by this very request.
          await dbService.markOutboxSyncedMany([...send, ...superseded].map((i) => i.id));
          continue;
        }

        if ((await classify(error, batch.tableName)) === 'session-lost') return;

        // The batch was rejected, but at most a few of its rows are actually at fault.
        // Re-send them individually so one bad record is isolated and charged, and every
        // other row in the run still reaches the cloud on this pass rather than
        // inheriting a backoff it did not earn.
        if (send.length === 1) {
          await fail(send[0], error.message);
          continue;
        }

        console.warn(
          `[Sync Store] Batch of ${send.length} ${batch.tableName} row(s) rejected (${error.message}); retrying individually to isolate the cause`
        );

        const deliveredRecords = new Set<string>();
        const acknowledge: string[] = [];

        for (const item of send) {
          const { error: rowError } = await push(batch, [item]);
          if (!rowError) {
            acknowledge.push(item.id);
            deliveredRecords.add(String(item.payload?.id));
            continue;
          }
          if ((await classify(rowError, batch.tableName)) === 'session-lost') return;
          await fail(item, rowError.message);
        }

        // A superseded row is only accounted for once its successor actually lands. If
        // that successor was the one the cloud rejected, the older snapshot has to stay
        // queued behind it rather than being quietly discarded.
        for (const item of superseded) {
          if (deliveredRecords.has(String(item.payload?.id))) acknowledge.push(item.id);
        }
        await dbService.markOutboxSyncedMany(acknowledge);
      }

      // Re-fetch remaining outbox queue size
      const remaining = await dbService.getPendingOutbox();
      const { total, stuck } = await dbService.countUnsyncedOutbox();
      set({
        pendingCount: total,
        stuckCount: stuck,
        pendingItems: remaining,
        isSyncing: false,
        lastSyncedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      console.error('[Outbox Sync Worker Exception]:', e.message || e);
      set({ isSyncing: false });
    }
  },

  forceSyncNow: async () => {
    await dbService.init();
    // Clear every backoff first. Without this the button is a lie on exactly the
    // occasions it matters most: after a spell offline, most of the queue is sitting out
    // a multi-minute timer, so pressing sync did nothing visible and the count kept
    // trickling down on its own schedule.
    const revived = await dbService.revivePendingOutbox();
    if (revived) {
      console.info(`[Sync Store] Manual sync revived ${revived} parked row(s)`);
    }
    await get().checkOutbox();
    await get().triggerSyncWorker();
  },

  startBackgroundLoop: () => {
    // Avoid double initialization of the background interval timer
    if ((globalThis as any)._syncStoreInterval) return;
    
    (globalThis as any)._syncStoreInterval = setInterval(async () => {
      const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
      set({ isOnline: online });

      if (!online || !isSupabaseConfigured) return;

      // Silently refresh outbox and sync pending rows
      await get().checkOutbox();
      if (get().pendingCount > 0 && !get().isSyncing) {
        await get().triggerSyncWorker();
      }
    }, 15000); // Poll every 15 seconds
  },
}));
