import { create } from 'zustand';
import { Shift } from '../types/shift';
import { dbService } from '../services/db/LocalStorageDbService';
import { calculateShiftReconciliation } from '../utils/reconciliation';
import { useTicketStore } from './useTicketStore';
import { useExpenseStore } from './useExpenseStore';

interface ShiftState {
  currentShift: Shift | null;
  isLoading: boolean;
  loadShift: (userId?: string) => Promise<void>;
  openShift: (openingFloat: number, cashierName?: string) => Promise<Shift>;
  closeShift: (countedCash: number, notes?: string) => Promise<Shift>;
}

export const useShiftStore = create<ShiftState>((set, get) => ({
  currentShift: null,
  isLoading: false,

  loadShift: async (userId?: string) => {
    set({ isLoading: true });
    await dbService.init();
    const shift = await dbService.getCurrentShift(userId);
    set({ currentShift: shift, isLoading: false });
  },

  openShift: async (openingFloat: number, cashierName: string = 'Main Cashier') => {
    const newShift: Shift = {
      id: crypto.randomUUID(),
      locationId: 'LOC01',
      deviceId: 'DEV01',
      cashierId: 'CASHIER-01',
      cashierName,
      status: 'open',
      openedAt: new Date().toISOString(),
      openingFloat,
    };

    await dbService.saveShift(newShift);
    set({ currentShift: newShift });
    return newShift;
  },

  closeShift: async (countedCash: number, notes?: string) => {
    const shift = get().currentShift;
    if (!shift) throw new Error('No active shift to close');

    // Calculate total cash tickets for this shift
    const tickets = useTicketStore.getState().tickets;
    const shiftTickets = tickets.filter(
      t => t.status === 'paid' || t.status === 'collected'
    );
    const totalCashTickets = shiftTickets.reduce((sum, t) => sum + t.amount, 0);

    // Calculate total approved expenses for this shift
    const expenses = await dbService.getExpenses(shift.id);
    const approvedExpenses = expenses
      .filter(e => e.status === 'approved')
      .reduce((sum, e) => sum + e.amount, 0);

    // Calculate Reconciliation & Variance
    const recon = calculateShiftReconciliation(
      shift.openingFloat,
      totalCashTickets,
      approvedExpenses,
      countedCash
    );

    await dbService.closeShift(
      shift.id,
      recon.countedCash,
      recon.expectedCash,
      recon.variance,
      notes
    );

    set({ currentShift: null });
    await get().loadShift();

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
