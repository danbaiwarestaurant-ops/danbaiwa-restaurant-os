import { create } from 'zustand';
import { Ticket, TicketTender } from '../types/ticket';
import { dbService } from '../services/db/IndexedDbService';
import { generateCompositeKey } from '../utils/compositeKey';
import { ticketQrPayload } from '../services/db/remoteMerge';
import { PrintAdapter } from '../services/print/PrintAdapter';
import { useDeviceStore } from './useDeviceStore';
import { useSyncStore } from './useSyncStore';

interface TicketState {
  tickets: Ticket[];
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
  /**
   * A print that failed after the sale was already recorded and shown.
   *
   * Printing no longer blocks the ticket, so a failure can no longer be reported by
   * the return value — but it must still be reported. App picks this up and raises
   * the error toast, so an unplugged printer is noticed at the counter rather than
   * discovered at the end of the shift.
   */
  printError: string | null;
  clearPrintError: () => void;
  loadTickets: (userId?: string) => Promise<void>;
  /** Tender defaults to cash: the fast path at the counter must stay the fast path. */
  createAndPrintTicket: (amount: number, cashierId?: string, tender?: TicketTender) => Promise<{ success: boolean; ticket?: Ticket; message: string }>;
  markCollected: (ticketId: string) => Promise<void>;
  voidTicket: (ticketId: string, reason: string, voidedBy: string) => Promise<void>;
  /** Fixes a mis-tagged payment type without voiding and reprinting the customer's ticket. */
  changeTender: (ticketId: string, tender: TicketTender, actorId: string) => Promise<void>;
  triggerFlash: (amount: number) => void;
}

/**
 * The header's counters are the *shift's*, not the store's, and are derived in Header.tsx
 * from the open shift's own tickets. There is deliberately no day-scoped total kept here:
 * a till worked by two people in a day would have shown each of them the other's takings.
 */
export const useTicketStore = create<TicketState>((set, get) => ({
  tickets: [],
  isLoading: false,
  activeFlashingAmount: null,
  scope: undefined,
  printError: null,
  clearPrintError: () => set({ printError: null }),

  loadTickets: async (userId?: string) => {
    set({ isLoading: true, scope: userId });
    await dbService.init();
    const tickets = await dbService.getTickets(userId);
    set({ tickets, isLoading: false });
  },

  createAndPrintTicket: async (amount: number, cashierId: string = '', tender: TicketTender = 'cash') => {
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
      tender,
      createdAt: nowIso,
      cashierId,
      // The one definition of this text. A ticket arriving from another till has it
      // rebuilt from the same function (see ticketQrPayload), because the cloud no longer
      // stores a copy — so the two must never drift apart.
      qrPayload: ticketQrPayload({ id: compositeId, amount, createdAt: nowIso }),
    };

    // Commit to DB (synchronous — ticket row is durable before print fires)
    await dbService.saveTicket(newTicket);

    // STEP 2: Update UI state with committed ticket. Filter out any existing entry
    // for this id first — a concurrent reload (reconciliation pull, realtime echo)
    // can land between the saveTicket() above and this point and already have
    // picked up the just-saved row, which would otherwise duplicate it here.
    const currentTickets = get().tickets.filter(t => t.id !== newTicket.id);
    const updatedTickets = [newTicket, ...currentTickets];
    set({ tickets: updatedTickets });

    // STEP 3: Visual flash effect
    get().triggerFlash(amount);

    // STEP 4: Dispatch the print — deliberately NOT awaited.
    //
    // The sale is already committed and on screen; the paper is a side effect of it,
    // not part of it. Awaiting the printer made the whole till feel slow: the toast,
    // the sidebar entry and the next keystroke all waited on a spooler round trip, so
    // the cashier stood still for as long as the printer took. Silent printing exists
    // to save time at the counter, and blocking on it spent that saving straight back.
    //
    // Failures are surfaced through printError instead of the return value.
    void PrintAdapter.printTicket(newTicket, config.businessName, config.paperWidthMm)
      .then((printRes) => {
        if (!printRes.success) {
          set({ printError: `Ticket #${newTicket.id} did not print: ${printRes.message}` });
        }
      })
      .catch((e: any) => {
        set({ printError: `Ticket #${newTicket.id} did not print: ${e?.message || 'unknown printer error'}` });
      });

    // Trigger outbox check and immediate cloud sync push
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });

    return {
      success: true,
      ticket: newTicket,
      message: `Ticket #${newTicket.id} issued`,
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

  changeTender: async (ticketId: string, tender: TicketTender, actorId: string) => {
    await dbService.updateTicketTender(ticketId, tender, actorId);
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
