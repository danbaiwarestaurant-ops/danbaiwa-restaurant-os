import { create } from 'zustand';
import { Shift } from '../types/shift';
import { dbService } from '../services/db/IndexedDbService';
import { calculateShiftReconciliation } from '../utils/reconciliation';
import { shiftTickets, splitByTender } from '../utils/analytics';
import { useAuthStore } from './useAuthStore';
import { useSyncStore } from './useSyncStore';
import { useDeviceStore } from './useDeviceStore';

interface ShiftState {
  currentShift: Shift | null;
  /**
   * Every shift, for the console's reconciliation view. Separate from `currentShift`,
   * which is strictly the signed-in user's own open shift and gates ticket issuing —
   * conflating the two would make an admin's shift button reflect somebody else's shift.
   */
  shiftHistory: Shift[];
  isLoading: boolean;
  loadShift: (userId?: string) => Promise<void>;
  loadShiftHistory: () => Promise<void>;
  openShift: (openingFloat?: number, cashierName?: string, cashierId?: string) => Promise<Shift>;
  closeShift: (countedCash: number, notes?: string) => Promise<Shift>;
}

export const useShiftStore = create<ShiftState>((set, get) => ({
  currentShift: null,
  shiftHistory: [],
  isLoading: false,

  loadShiftHistory: async () => {
    await dbService.init();
    const shifts = await dbService.getShifts();
    shifts.sort((a, b) => (b.openedAt || '').localeCompare(a.openedAt || ''));
    set({ shiftHistory: shifts });
  },

  loadShift: async (userId?: string) => {
    set({ isLoading: true });
    await dbService.init();
    const shift = await dbService.getCurrentShift(userId);
    set({ currentShift: shift, isLoading: false });
  },

  // openingFloat defaults to 0: opening a shift is a one-click confirmation and no
  // longer prompts for a cash float. calculateShiftReconciliation clamps it, so close-out
  // simply reconciles tickets minus approved expenses.
  openShift: async (openingFloat: number = 0, cashierName?: string, cashierId?: string) => {
    // Use active authenticated user if not provided
    const activeUser = useAuthStore.getState().activeUser;
    const resolvedCashierId = cashierId || activeUser?.id || '';
    const resolvedCashierName = cashierName || activeUser?.name || 'Cashier';

    // Was hardcoded to LOC01/DEV01, ignoring config entirely — which is why a
    // misconfigured scope surfaced as an RLS rejection on shifts before any other table.
    const config = useDeviceStore.getState().config;

    const newShift: Shift = {
      id: crypto.randomUUID(),
      locationId: config.locationId || 'LOC01',
      deviceId: config.deviceId || 'DEV01',
      cashierId: resolvedCashierId,
      cashierName: resolvedCashierName,
      status: 'open',
      openedAt: new Date().toISOString(),
      openingFloat,
    };

    await dbService.saveShift(newShift);
    set({ currentShift: newShift });
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return newShift;
  },

  closeShift: async (countedCash: number, notes?: string) => {
    const shift = get().currentShift;
    if (!shift) throw new Error('No active shift to close');

    // Read this cashier's tickets straight from the database rather than the store: the
    // store is scoped to whoever is signed in, which for an admin is every cashier's
    // tickets and for a cashier may be a stale subset.
    //
    // Previously this summed *every* ticket in the store with no window at all, so
    // expected cash was the account's lifetime revenue and the variance written against
    // the shift was nonsense. shiftTickets bounds it to this cashier, this shift.
    // Cash only — card and transfer sales are revenue but never entered the drawer, so
    // counting them into expected cash would flag every non-cash sale as a shortage.
    const cashierTickets = await dbService.getTickets(shift.cashierId);
    const totalCashTickets = splitByTender(
      shiftTickets(cashierTickets, { ...shift, closedAt: new Date().toISOString() })
    ).cash;

    const expenses = await dbService.getExpenses(shift.id);
    const approvedExpenses = expenses.filter(e => e.status === 'approved').reduce((sum, e) => sum + e.amount, 0);

    const recon = calculateShiftReconciliation(shift.openingFloat, totalCashTickets, approvedExpenses, countedCash);

    await dbService.closeShift(shift.id, recon.countedCash, recon.expectedCash, recon.variance, notes);

    set({ currentShift: null });
    // Scoped to the cashier who owned it — an unscoped reload could pick up a *different*
    // user's open shift and present it as this till's own.
    await get().loadShift(shift.cashierId);
    await get().loadShiftHistory();
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });

    return {
      ...shift,
      status: 'closed',
      closedAt: new Date().toISOString(),
      countedCash: recon.countedCash,
      expectedCash: recon.expectedCash,
      variance: recon.variance,
      notes,
    };
  },
}));
