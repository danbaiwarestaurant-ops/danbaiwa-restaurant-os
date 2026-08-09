import { create } from 'zustand';
import { Expense } from '../types/expense';
import { dbService } from '../services/db/LocalStorageDbService';
import { useShiftStore } from './useShiftStore';

interface ExpenseState {
  expenses: Expense[];
  isLoading: boolean;
  loadExpenses: () => Promise<void>;
  logExpense: (amount: number, category: string, description: string) => Promise<Expense>;
  approveExpense: (expenseId: string, reviewerName: string) => Promise<void>;
  rejectExpense: (expenseId: string, reviewerName: string, reason: string) => Promise<void>;
}

export const useExpenseStore = create<ExpenseState>((set, get) => ({
  expenses: [],
  isLoading: false,

  loadExpenses: async () => {
    set({ isLoading: true });
    await dbService.init();
    const expenses = await dbService.getExpenses();
    set({ expenses, isLoading: false });
  },

  logExpense: async (amount: number, category: string, description: string) => {
    const shift = useShiftStore.getState().currentShift;
    const newExpense: Expense = {
      id: crypto.randomUUID(),
      shiftId: shift?.id || 'GLOBAL_SHIFT',
      cashierId: shift?.cashierId || 'CASHIER-01',
      cashierName: shift?.cashierName || 'Cashier',
      amount,
      category,
      description,
      status: 'pending',
      loggedAt: new Date().toISOString(),
    };

    await dbService.saveExpense(newExpense);
    await get().loadExpenses();
    return newExpense;
  },

  approveExpense: async (expenseId: string, reviewerName: string = 'Manager') => {
    await dbService.updateExpenseStatus(expenseId, 'approved', reviewerName);
    await get().loadExpenses();
  },

  rejectExpense: async (expenseId: string, reviewerName: string = 'Manager', reason: string) => {
    await dbService.updateExpenseStatus(expenseId, 'rejected', reviewerName, reason);
    await get().loadExpenses();
  },
}));
