import { create } from 'zustand';
import { Ticket, TicketTender } from '../types/ticket';
import { dbService } from '../services/db/IndexedDbService';
import { generateCompositeKey } from '../utils/compositeKey';
import { PrintAdapter } from '../services/print/PrintAdapter';
import { useDeviceStore } from './useDeviceStore';
import { useSyncStore } from './useSyncStore';
import { dayKey } from '../utils/analytics';

interface TicketState {
  tickets: Ticket[];
  ticketsTodayCount: number;
  /** What those tickets came to. Voids excluded, exactly as in the count beside it. */
  ticketsTodayTotal: number;
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
 * Today's tickets and what they came to, for the header counters.
 *
 * The day boundary is **local**, via dayKey — not the UTC date prefix this used to
 * compare against. In Lagos (UTC+1) that boundary falls at 1am local, so a restaurant
 * still serving after midnight had the first hour of its night counted into the previous
 * day. It never showed up while the only figure was a ticket count; it would show up
 * immediately now that a money total sits beside it and gets checked against a drawer.
 * See AGENTS.md rule 8 — every reported window in this app is local time.
 */
function summariseToday(tickets: Ticket[]): { count: number; amount: number } {
  const today = dayKey(new Date());
  const mine = tickets.filter((t) => t.status !== 'void' && dayKey(t.createdAt) === today);
  return {
    count: mine.length,
    amount: mine.reduce((sum, t) => sum + (t.amount || 0), 0),
  };
}

export const useTicketStore = create<TicketState>((set, get) => ({
  tickets: [],
  ticketsTodayCount: 0,
  ticketsTodayTotal: 0,
  isLoading: false,
  activeFlashingAmount: null,
  scope: undefined,
  printError: null,
  clearPrintError: () => set({ printError: null }),

  loadTickets: async (userId?: string) => {
    set({ isLoading: true, scope: userId });
    await dbService.init();
    const tickets = await dbService.getTickets(userId);
    const today = summariseToday(tickets);
    set({ tickets, ticketsTodayCount: today.count, ticketsTodayTotal: today.amount, isLoading: false });
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
    const today = summariseToday(updatedTickets);
    set({ tickets: updatedTickets, ticketsTodayCount: today.count, ticketsTodayTotal: today.amount });

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
