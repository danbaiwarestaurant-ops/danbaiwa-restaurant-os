import { create } from 'zustand';
import { SyncState, OutboxItem } from '../types/sync';
import { dbService } from '../services/db/SqliteDbService';

interface SyncStoreState extends SyncState {
  pendingItems: OutboxItem[];
  checkOutbox: () => Promise<void>;
  triggerSyncWorker: () => Promise<void>;
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  isOnline: true,
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
    });
  },

  triggerSyncWorker: async () => {
    if (get().isSyncing || get().pendingCount === 0) return;
    set({ isSyncing: true });

    try {
      const items = await dbService.getPendingOutbox();
      for (const item of items) {
        // Simulate Supabase background worker push with client UUID idempotency
        await new Promise(r => setTimeout(r, 200));
        await dbService.markOutboxSynced(item.id);
      }
      const remaining = await dbService.getPendingOutbox();
      set({
        pendingCount: remaining.length,
        pendingItems: remaining,
        isSyncing: false,
        lastSyncedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[Outbox Sync Worker Error]:', e);
      set({ isSyncing: false });
    }
  },
}));
