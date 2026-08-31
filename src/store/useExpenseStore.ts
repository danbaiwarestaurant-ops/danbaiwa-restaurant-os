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
    const newExpense: Expense = {
      id: crypto.randomUUID(),
      shiftId: shift?.id || '',
      cashierId: activeUser?.id || shift?.cashierId || '',
      cashierName: activeUser?.name || shift?.cashierName || 'Cashier',
      amount,
      category,
      description,
      status: 'pending',
      loggedAt: new Date().toISOString(),
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
