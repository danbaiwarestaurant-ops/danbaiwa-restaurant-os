import { create } from 'zustand';
import { Ticket } from '../types/ticket';
import { dbService } from '../services/db/IndexedDbService';
import { generateCompositeKey } from '../utils/compositeKey';
import { PrintAdapter } from '../services/print/PrintAdapter';
import { useDeviceStore } from './useDeviceStore';
import { useSyncStore } from './useSyncStore';

interface TicketState {
  tickets: Ticket[];
  ticketsTodayCount: number;
  isLoading: boolean;
  activeFlashingAmount: number | null;
  /**
   * Whose tickets the list currently holds — undefined means the whole account.
   *
   * Remembered so that an internal refresh after a void or a collection reloads the *same*
   * scope. Calling loadTickets() bare, as those used to, silently widened a cashier's till
   * to every cashier's tickets the first time they voided anything.
   */
  scope: string | undefined;
  loadTickets: (userId?: string) => Promise<void>;
  createAndPrintTicket: (amount: number, cashierId?: string) => Promise<{ success: boolean; ticket?: Ticket; message: string }>;
  markCollected: (ticketId: string) => Promise<void>;
  voidTicket: (ticketId: string, reason: string, voidedBy: string) => Promise<void>;
  triggerFlash: (amount: number) => void;
}

export const useTicketStore = create<TicketState>((set, get) => ({
  tickets: [],
  ticketsTodayCount: 0,
  isLoading: false,
  activeFlashingAmount: null,
  scope: undefined,

  loadTickets: async (userId?: string) => {
    set({ isLoading: true, scope: userId });
    await dbService.init();
    const tickets = await dbService.getTickets(userId);
    const todayStr = new Date().toISOString().split('T')[0];
    const todayCount = tickets.filter(t => t.createdAt.startsWith(todayStr) && t.status !== 'void').length;
    set({ tickets, ticketsTodayCount: todayCount, isLoading: false });
  },

  createAndPrintTicket: async (amount: number, cashierId: string = '') => {
    const config = useDeviceStore.getState().config;
    const locationId = config.locationId || 'LOC01';
    const deviceId = config.deviceId || 'DEV01';

    /**
     * STEP 1: Atomically commit sequence + ticket to SQLite BEFORE printing.
     *
     * getNextSeq() wraps the sequence increment in a BEGIN/COMMIT transaction.
     * If two rapid prints hit this simultaneously, SQLite serialises them —
     * one gets seq=1, the other gets seq=2. No duplicates, no gaps, ever.
     *
     * If the browser crashes AFTER this await resolves, the ticket row is in
     * the database. If it crashes before, the insert never happened.
     * Either way the DB and receipt are always in sync.
     */
    await dbService.init();
    const installationId = await dbService.getInstallationId();
    const nextSeq = await dbService.getNextSeq(locationId, deviceId);
    const compositeId = generateCompositeKey(locationId, deviceId, nextSeq, installationId);
    const nowIso = new Date().toISOString();

    const newTicket: Ticket = {
      id: compositeId,
      locationId,
      deviceId,
      localSeq: nextSeq,
      amount,
      currency: config.currencySymbol || '₦',
      status: 'paid',
      createdAt: nowIso,
      cashierId,
      qrPayload: `TICKET|${compositeId}|${amount}|${nowIso}`,
    };

    // Commit to DB (synchronous — ticket row is durable before print fires)
    await dbService.saveTicket(newTicket);

    // STEP 2: Update UI state with committed ticket. Filter out any existing entry
    // for this id first — a concurrent reload (reconciliation pull, realtime echo)
    // can land between the saveTicket() above and this point and already have
    // picked up the just-saved row, which would otherwise duplicate it here.
    const currentTickets = get().tickets.filter(t => t.id !== newTicket.id);
    const updatedTickets = [newTicket, ...currentTickets];
    const todayStr = nowIso.split('T')[0];
    const todayCount = updatedTickets.filter(t => t.createdAt.startsWith(todayStr) && t.status !== 'void').length;
    set({ tickets: updatedTickets, ticketsTodayCount: todayCount });

    // STEP 3: Visual flash effect
    get().triggerFlash(amount);

    // STEP 4: Dispatch thermal print (after DB commit — crash-safe)
    const printRes = await PrintAdapter.printTicket(newTicket, config.businessName);

    // Trigger outbox check and immediate cloud sync push
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });

    return {
      success: true,
      ticket: newTicket,
      message: printRes.message,
    };
  },

  markCollected: async (ticketId: string) => {
    await dbService.updateTicketStatus(ticketId, 'collected');
    await get().loadTickets(get().scope);
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
  },

  voidTicket: async (ticketId: string, reason: string, voidedBy: string) => {
    await dbService.updateTicketStatus(ticketId, 'void', reason, voidedBy);
    await get().loadTickets(get().scope);
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
  },

  triggerFlash: (amount: number) => {
    set({ activeFlashingAmount: amount });
    setTimeout(() => {
      if (get().activeFlashingAmount === amount) {
        set({ activeFlashingAmount: null });
      }
    }, 250);
  },
}));
