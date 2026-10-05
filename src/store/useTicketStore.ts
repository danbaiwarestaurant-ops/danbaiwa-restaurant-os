import { useShiftStore } from './useShiftStore';
import { create } from 'zustand';
import { Ticket, TicketTender } from '../types/ticket';
import { dbService } from '../services/db/IndexedDbService';
import { generateCompositeKey } from '../utils/compositeKey';
import { ticketQrPayload } from '../services/db/remoteMerge';
import { PrintAdapter } from '../services/print/PrintAdapter';
import { useDeviceStore } from './useDeviceStore';
import { useSyncStore } from './useSyncStore';
import { useAuthStore } from './useAuthStore';
import { roleLabel } from '../utils/roles';
import { WageLedgerEntry } from '../types/workforce';
import { businessDayKey } from '../utils/shiftDay';
import { ShiftSummary } from '../services/db/shiftSummaries';
import { useConsolePeriodStore } from './useConsolePeriodStore';

interface TicketState {
  tickets: Ticket[];
  hasOlderTickets: boolean;
  browsingOlder: boolean;
  shiftSummary: ShiftSummary | null;
  refreshShiftSummary: () => Promise<void>;
  loadOlderTickets: () => Promise<void>;
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
  /**
   * Tender defaults to cash: the fast path at the counter must stay the fast path.
   *
   * `staffMeal` names the employee a 'staff' ticket is for. It is required in practice
   * for that tender — a staff meal attributable to nobody is just an untracked giveaway —
   * and enforced here rather than in the UI so no future caller can skip it.
   */
  createAndPrintTicket: (
    amount: number,
    cashierId?: string,
    tender?: TicketTender,
    staffMeal?: { staffId: string; staffName: string; description?: string; options?: Array<{ id: string; name: string; wageCharge: number; isFree: boolean }>; wageDeduction?: number }
  ) => Promise<{ success: boolean; ticket?: Ticket; message: string }>;
  markCollected: (ticketId: string) => Promise<void>;
  voidTicket: (ticketId: string, reason: string, voidedBy: string) => Promise<void>;
  /** Fixes a mis-tagged payment type without voiding and reprinting the customer's ticket. */
  changeTender: (ticketId: string, tender: TicketTender, actorId: string) => Promise<void>;
  triggerFlash: (amount: number) => void;
}

/**
 * The till holds a bounded recent page. Its counters use complete, persisted totals
 * for the open shift, maintained atomically with ticket writes in IndexedDB.
 */
let ticketLoadGeneration = 0;
let ticketWriteGeneration = 0;
let summaryGeneration = 0;
const committedDuringLoads = new Map<string, { version: number; ticket: Ticket }>();

export const useTicketStore = create<TicketState>((set, get) => ({
  tickets: [],
  hasOlderTickets: false,
  browsingOlder: false,
  shiftSummary: null,
  isLoading: false,
  activeFlashingAmount: null,
  scope: undefined,
  printError: null,
  clearPrintError: () => set({ printError: null }),

  refreshShiftSummary: async () => {
    const generation = ++summaryGeneration;
    const shift = useShiftStore.getState().currentShift;
    if (!shift) { set({ shiftSummary: null }); return; }
    const summary = await dbService.getShiftSummary(shift);
    if (generation === summaryGeneration && useShiftStore.getState().currentShift?.id === shift.id) set({ shiftSummary: summary });
  },
  loadOlderTickets: async () => {
    const { tickets, scope } = get();
    if (!scope || !tickets.length) return;
    const last = tickets[tickets.length - 1];
    const older = await dbService.getRecentTickets(scope, last, 201);
    if (get().scope === scope && get().tickets === tickets) set({
      ...(older.length ? { tickets: older.slice(0, 200), browsingOlder: true } : {}), hasOlderTickets: older.length > 200,
    });
  },
  loadTickets: async (userId?: string) => {
    const generation = ++ticketLoadGeneration;
    const writeVersion = ticketWriteGeneration;
    set({ isLoading: true, scope: userId });
    try {
      await dbService.init();
      const tickets = userId ? await dbService.getRecentTickets(userId, undefined, 201) :
        await dbService.getTicketsInPeriod(useConsolePeriodStore.getState().period);
      if (generation !== ticketLoadGeneration) return;
      const merged = new Map(tickets.map(ticket => [ticket.id, ticket]));
      for (const { version, ticket } of committedDuringLoads.values()) {
        if (version > writeVersion && (!userId || ticket.cashierId === userId)) merged.set(ticket.id, ticket);
      }
      committedDuringLoads.clear();
      const sorted = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      set({ tickets: userId ? sorted.slice(0, 200) : sorted, hasOlderTickets: !!userId && sorted.length > 200, browsingOlder: false, isLoading: false });
      await get().refreshShiftSummary();
    } catch (error) {
      if (generation === ticketLoadGeneration) set({ isLoading: false });
      throw error;
    }
  },

  createAndPrintTicket: async (
    amount: number,
    cashierId: string = '',
    tender: TicketTender = 'cash',
    staffMeal?: { staffId: string; staffName: string; description?: string; options?: Array<{ id: string; name: string; wageCharge: number; isFree: boolean }>; wageDeduction?: number }
  ) => {
    // Refused rather than defaulted. A staff meal with no employee on it cannot be
    // reported, cannot be questioned, and is indistinguishable from food walking out of
    // the kitchen — which is the exact thing recording staff meals exists to prevent.
    if (tender === 'staff' && !staffMeal?.staffId) {
      return {
        success: false,
        message: 'A staff meal has to name the employee it is for.',
      };
    }

    const config = useDeviceStore.getState().config;
    const locationId = config.locationId || 'LOC01';
    const deviceId = config.deviceId || 'DEV01';

    // Reserve a unique sequence, then commit the ticket and its outbox entry before
    // printing. A crash between those transactions can leave a numbering gap; it can
    // never reuse a committed ticket number or print an uncommitted sale.
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
      accountId: useAuthStore.getState().activeUser?.accountId,
      shiftId: useShiftStore.getState().currentShift?.cashierId === cashierId
        ? useShiftStore.getState().currentShift?.id : undefined,
      ...(tender === 'staff' && staffMeal
        ? {
            staffId: staffMeal.staffId,
            staffName: staffMeal.staffName,
            mealOptions: staffMeal.options,
            staffMealWageDeduction: Math.max(0, staffMeal.wageDeduction || 0),
            ...(staffMeal.description?.trim()
              ? { mealDescription: staffMeal.description.trim() }
              : {}),
          }
        : {}),
      // The one definition of this text. A ticket arriving from another till has it
      // rebuilt from the same function (see ticketQrPayload), because the cloud no longer
      // stores a copy — so the two must never drift apart.
      qrPayload: ticketQrPayload({ id: compositeId, amount, createdAt: nowIso }),
    };

    // Commit to DB (synchronous — ticket row is durable before print fires)
    const mealDeduction = Math.max(0, staffMeal?.wageDeduction || 0);
    const mealWageEntry: WageLedgerEntry | undefined = tender === 'staff' && staffMeal && (mealDeduction > 0 || staffMeal.options?.length)
      ? {
          id: crypto.randomUUID(),
          staffId: staffMeal.staffId,
          staffName: staffMeal.staffName,
          businessDay: businessDayKey(nowIso, config.businessDayStartHour),
          kind: 'manual_adjustment',
          amount: -mealDeduction,
          note: `Staff meal deduction: ${(staffMeal.options || []).filter((o) => o.wageCharge > 0).map((o) => o.name).join(', ') || 'extra meal'}`,
          recordedBy: cashierId,
          recordedByName: useAuthStore.getState().activeUser?.name,
          recordedAt: nowIso,
        }
      : undefined;
    if (tender === 'staff') await dbService.saveStaffMealTicket(newTicket, mealWageEntry);
    else await dbService.saveTicket(newTicket);

    // STEP 2: Update UI state with committed ticket. Filter out any existing entry
    // for this id first — a concurrent reload (reconciliation pull, realtime echo)
    // can land between the saveTicket() above and this point and already have
    // picked up the just-saved row, which would otherwise duplicate it here.
    if (get().isLoading) committedDuringLoads.set(newTicket.id, { version: ++ticketWriteGeneration, ticket: newTicket });
    else ticketWriteGeneration++;
    if (!get().scope || get().scope === newTicket.cashierId) {
      const currentTickets = get().tickets.filter(t => t.id !== newTicket.id);
      const updatedTickets = get().scope ? [newTicket, ...currentTickets].slice(0, 200) : [newTicket, ...currentTickets];
      set({ tickets: updatedTickets, hasOlderTickets: !!get().scope && (get().hasOlderTickets || currentTickets.length >= 200) });
    }

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
    // The roster facts the receipt needs and the ticket row does not hold: what the
    // employee does, and who authorised the plate. Resolved here rather than stored,
    // because both are properties of the roster and would go stale on the record.
    const printContext =
      tender === 'staff' && staffMeal
        ? {
            staffRoleText: roleLabel(
              useAuthStore.getState().users.find((u) => u.id === staffMeal.staffId)?.role
            ),
            issuedByName: useAuthStore.getState().users.find((u) => u.id === cashierId)?.name,
          }
        : undefined;

    void PrintAdapter.printTicket(newTicket, config.businessName, config.paperWidthMm, printContext)
      .then((printRes) => {
        if (!printRes.success) {
          set({ printError: `Ticket #${newTicket.id} did not print: ${printRes.message}` });
        }
      })
      .catch((e: any) => {
        set({ printError: `Ticket #${newTicket.id} did not print: ${e?.message || 'unknown printer error'}` });
      });

    void get().refreshShiftSummary();
    if (get().browsingOlder) void get().loadTickets(get().scope);

    // Trigger outbox check and immediate cloud sync push
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });

    return {
      success: true,
      ticket: newTicket,
      message:
        tender === 'staff' && staffMeal
          ? `Staff meal #${newTicket.id} issued for ${staffMeal.staffName}`
          : `Ticket #${newTicket.id} issued`,
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
