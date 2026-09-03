import { create } from 'zustand';
import { Expense } from '../types/expense';
import { dbService } from '../services/db/IndexedDbService';
import { useShiftStore } from './useShiftStore';
import { useAuthStore } from './useAuthStore';
import { useSyncStore } from './useSyncStore';

interface ExpenseState {
  expenses: Expense[];
  isLoading: boolean;
  /**
   * The filter the list was last loaded with. Remembered for the same reason as the ticket
   * store's: an internal refresh after logging or approving an expense must reload the
   * scope the view is actually showing, not silently fall back to the whole account.
   */
  scope: { shiftId?: string; userId?: string };
  loadExpenses: (shiftId?: string, userId?: string) => Promise<void>;
  /**
   * Records a payout the cashier has already made out of the drawer.
   *
   * Approved on entry, signed with the shift-holder's own PIN — see the status note in
   * the implementation. A manager reverses it from the console if it was not legitimate.
   */
  logExpense: (amount: number, category: string, description: string) => Promise<Expense>;
  approveExpense: (expenseId: string, reviewerName: string) => Promise<void>;
  rejectExpense: (expenseId: string, reviewerName: string, reason: string) => Promise<void>;
}

export const useExpenseStore = create<ExpenseState>((set, get) => ({
  expenses: [],
  isLoading: false,
  scope: {},

  loadExpenses: async (shiftId?: string, userId?: string) => {
    set({ isLoading: true, scope: { shiftId, userId } });
    await dbService.init();
    const expenses = await dbService.getExpenses(shiftId, userId);
    set({ expenses, isLoading: false });
  },

  logExpense: async (amount: number, category: string, description: string) => {
    const shift = useShiftStore.getState().currentShift;
    const activeUser = useAuthStore.getState().activeUser;
    const now = new Date().toISOString();
    const signedBy = activeUser?.name || shift?.cashierName || 'Cashier';

    /**
     * Approved on entry, not pending.
     *
     * The money has already left the drawer by the time anyone types this in — the gas is
     * bought, the vendor is paid. A 'pending' expense did not reflect that: expected cash
     * still counted the money as present, so every unreviewed payout showed up as a
     * shortage against the cashier at close-out, and the drawer only balanced once a
     * manager happened to log in. Recording it as approved makes the till agree with the
     * drawer immediately.
     *
     * What keeps it honest is the PIN the cashier enters to submit it (see
     * ExpenseLoggerModal) — it is their signature on the payout — and the manager's power
     * to reject it afterwards, which puts the amount straight back into expected cash.
     */
    const newExpense: Expense = {
      id: crypto.randomUUID(),
      shiftId: shift?.id || '',
      cashierId: activeUser?.id || shift?.cashierId || '',
      cashierName: signedBy,
      amount,
      category,
      description,
      status: 'approved',
      loggedAt: now,
      reviewedBy: signedBy,
      reviewedAt: now,
    };

    await dbService.saveExpense(newExpense);
    await get().loadExpenses(get().scope.shiftId, get().scope.userId);
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
    return newExpense;
  },

  approveExpense: async (expenseId: string, reviewerName: string = 'Manager') => {
    await dbService.updateExpenseStatus(expenseId, 'approved', reviewerName);
    await get().loadExpenses(get().scope.shiftId, get().scope.userId);
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
  },

  rejectExpense: async (expenseId: string, reviewerName: string = 'Manager', reason: string) => {
    await dbService.updateExpenseStatus(expenseId, 'rejected', reviewerName, reason);
    await get().loadExpenses(get().scope.shiftId, get().scope.userId);
    useSyncStore.getState().checkOutbox().then(() => {
      useSyncStore.getState().triggerSyncWorker();
    });
  },
}));
