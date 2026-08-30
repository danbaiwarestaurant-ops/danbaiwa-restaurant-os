import { create } from 'zustand';
import { SyncState, OutboxItem } from '../types/sync';
import { dbService } from '../services/db/IndexedDbService';
import { supabase, isSupabaseConfigured } from '../services/supabase/supabaseClient';
import { useDeviceStore } from './useDeviceStore';
import { toSnakeCase } from '../utils/caseMapping';

interface SyncStoreState extends SyncState {
  pendingItems: OutboxItem[];
  checkOutbox: () => Promise<void>;
  triggerSyncWorker: () => Promise<void>;
  startBackgroundLoop: () => void;
}

/**
 * True when a push was rejected for a reason that has nothing to do with the row
 * itself — no session, an expired JWT, or an RLS policy the anonymous role can't
 * satisfy. Those must never count against a row's retry budget: the row is fine, the
 * till just isn't authenticated, and charging it for that is exactly how a couple of
 * cloud-less minutes used to orphan a day of tickets permanently.
 */
function isAuthOrPolicyFailure(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  const msg = String(error.message ?? '').toLowerCase();
  return (
    code === '42501' || // insufficient_privilege / RLS violation
    code === 'PGRST301' || // JWT expired or invalid
    msg.includes('row-level security') ||
    msg.includes('jwt') ||
    msg.includes('not authenticated') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid claim')
  );
}

/** Whether this browser currently holds a real Supabase session. */
async function hasCloudSession(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  try {
    const { data } = await supabase.auth.getSession();
    return Boolean(data?.session);
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
    // row a step closer to being written off.
    if (!(await hasCloudSession())) {
      set({
        cloudConnected: false,
        cloudError:
          get().cloudError ??
          'This till is not signed in to the cloud, so nothing can reach your other devices. Your work is queued safely — reconnect with the admin PIN to send it.',
      });
      console.debug('[Sync Store] Worker skipped: no cloud session (data stays queued)');
      return;
    }

    set({ isSyncing: true, cloudConnected: true, cloudError: null });

    try {
      const items = await dbService.getPendingOutbox();
      const locationId = useDeviceStore.getState().config.locationId || 'LOC01';

      for (const item of items) {
        try {
          // Prepare payload with camelCase -> snake_case conversion
          const supabasePayload = toSnakeCase(item.payload);

          // Inject location_id scope for tables whose local payload has no locationId
          // field of its own, to satisfy RLS policies.
          if (item.tableName === 'users' || item.tableName === 'audit_logs') {
            supabasePayload.location_id = locationId;
          }

          // Perform real cloud upsert using Client UUID primary key
          const { error } = await supabase
            .from(item.tableName)
            .upsert(supabasePayload, { onConflict: 'id' });

          if (error) {
            if (isAuthOrPolicyFailure(error)) {
              // The till lost its cloud authorisation mid-batch. Abort without charging
              // this row — or any row behind it — for something none of them caused.
              console.warn(
                '[Sync Store] Cloud authorisation lost mid-sync; queue left intact:',
                error.message
              );
              set({
                isSyncing: false,
                cloudConnected: false,
                cloudError: `The cloud rejected this till's credentials (${error.message}). Your work is queued safely — reconnect with the admin PIN to send it.`,
              });
              return;
            }
            throw Object.assign(new Error(error.message), { code: error.code });
          }

          // Mark local item as successfully synced
          await dbService.markOutboxSynced(item.id);
        } catch (itemError: any) {
          // One genuinely rejected record (schema mismatch, missing FK, etc.) must never
          // block every other queued ticket/shift/expense behind it in the batch. Back it
          // off exponentially and carry on — it keeps its place in the queue and is
          // surfaced as "stuck" rather than being dropped.
          console.error(
            `[Sync Store] Sync failed for ${item.tableName} record ${item.id} (attempt ${item.retryCount + 1}):`,
            itemError.message || itemError
          );
          await dbService.markOutboxAttemptFailed(
            item.id,
            item.retryCount,
            String(itemError?.message ?? itemError)
          );
        }
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
