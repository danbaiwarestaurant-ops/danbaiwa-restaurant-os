import { create } from 'zustand';
import { SyncState, OutboxItem } from '../types/sync';
import { dbService } from '../services/db/SqliteDbService';
import { supabase, isSupabaseConfigured } from '../services/supabase/supabaseClient';
import { useDeviceStore } from './useDeviceStore';

interface SyncStoreState extends SyncState {
  pendingItems: OutboxItem[];
  checkOutbox: () => Promise<void>;
  triggerSyncWorker: () => Promise<void>;
  startBackgroundLoop: () => void;
}

/** Helper utility to transform camelCase JavaScript objects into snake_case database rows */
function toSnakeCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    let val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      val = toSnakeCase(val);
    }
    result[snakeKey] = val;
  }
  return result;
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  pendingCount: 0,
  isSyncing: false,
  pendingItems: [],
  lastSyncedAt: undefined,

  checkOutbox: async () => {
    await dbService.init();
    const pending = await dbService.getPendingOutbox();
    set({
      pendingCount: pending.length,
      pendingItems: pending,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
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

    set({ isSyncing: true });

    try {
      const items = await dbService.getPendingOutbox();
      const locationId = useDeviceStore.getState().config.locationId || 'LOC01';

      for (const item of items) {
        // Prepare payload with camelCase -> snake_case conversion
        const supabasePayload = toSnakeCase(item.payload);

        // Inject location_id scope for users table to satisfy RLS policies (cashiers list)
        if (item.tableName === 'users') {
          supabasePayload.location_id = locationId;
        }

        // Perform real cloud upsert using Client UUID primary key
        const { error } = await supabase
          .from(item.tableName)
          .upsert(supabasePayload, { onConflict: 'id' });

        if (error) {
          // Check for RLS scope violation or permission error
          console.error(`[Sync Store] Sync failed for ${item.tableName} record ${item.id}:`, error.message);
          // Stop worker on failure to prevent transaction ordering issues
          throw new Error(`Cloud Sync Blocked: ${error.message}`);
        }

        // Mark local item as successfully synced
        await dbService.markOutboxSynced(item.id);
      }

      // Re-fetch remaining outbox queue size
      const remaining = await dbService.getPendingOutbox();
      set({
        pendingCount: remaining.length,
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
