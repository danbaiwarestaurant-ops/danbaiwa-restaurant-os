import { create } from 'zustand';
import { ServerSalesEntry, serverSalesId } from '../types/serverSales';
import { dbService } from '../services/db/IndexedDbService';
import { useAuthStore } from './useAuthStore';
import { useSyncStore } from './useSyncStore';

/**
 * The manager's record of how many tickets each server turned over.
 *
 * Unlike every other store here, nothing in this one is produced by the till. A server
 * takes orders on the floor and the cashier rings everything up, so the only place a
 * server's individual figure exists is on paper until a manager types it in. See
 * types/serverSales.ts.
 */
interface ServerSalesState {
  entries: ServerSalesEntry[];
  isLoading: boolean;
  /** The trading-day range the list was last loaded with, so an internal refresh keeps it. */
  scope: { from?: string; to?: string };
  loadServerSales: (from?: string, to?: string) => Promise<void>;
  /**
   * Records (or corrects) one server's count for one trading day.
   *
   * `businessDay` is a trading day key from businessDayKey — the 6am-to-6am day, so an
   * entry made at 1am after a late service still lands on the night that was worked.
   */
  recordCount: (input: {
    serverId: string;
    serverName: string;
    businessDay: string;
    ticketCount: number;
    note?: string;
  }) => Promise<ServerSalesEntry>;
  removeCount: (entryId: string) => Promise<void>;
  /** This day's entries, keyed by server id — what the entry form fills itself from. */
  countsForDay: (businessDay: string) => Record<string, ServerSalesEntry>;
}

export const useServerSalesStore = create<ServerSalesState>((set, get) => ({
  entries: [],
  isLoading: false,
  scope: {},

  loadServerSales: async (from?: string, to?: string) => {
    set({ isLoading: true, scope: { from, to } });
    await dbService.init();
    const entries = await dbService.getServerSales(from, to);
    set({ entries, isLoading: false });
  },

  recordCount: async ({ serverId, serverName, businessDay, ticketCount, note }) => {
    const actor = useAuthStore.getState().activeUser;
    const now = new Date().toISOString();

    const entry: ServerSalesEntry = {
      // Derived, not random — one server, one day, one number. See ServerSalesEntry.id.
      id: serverSalesId(businessDay, serverId),
      serverId,
      serverName,
      businessDay,
      // Whole tickets only, and never negative. A stray decimal from a text input would
      // otherwise reach the cloud and every total computed off it.
      ticketCount: Math.max(0, Math.round(ticketCount)),
      note: note?.trim() || undefined,
      recordedBy: actor?.id || '',
      recordedByName: actor?.name,
      recordedAt: now,
    };

    await dbService.init();
    await dbService.saveServerSales(entry);

    // Replace the day's row in place rather than appending, so re-entering a number does
    // not show the same server twice until the next reload.
    const rest = get().entries.filter((e) => e.id !== entry.id);
    set({ entries: [entry, ...rest] });

    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });

    return entry;
  },

  removeCount: async (entryId: string) => {
    await dbService.init();
    await dbService.deleteServerSales(entryId);
    set({ entries: get().entries.filter((e) => e.id !== entryId) });
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
  },

  countsForDay: (businessDay: string) => {
    const map: Record<string, ServerSalesEntry> = {};
    for (const e of get().entries) {
      if (e.businessDay === businessDay) map[e.serverId] = e;
    }
    return map;
  },
}));
