import { describe, it, expect, beforeEach } from 'vitest';
import { useExpenseStore } from '../store/useExpenseStore';
import { useShiftStore } from '../store/useShiftStore';
import { useAuthStore } from '../store/useAuthStore';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { calculateShiftReconciliation } from '../utils/reconciliation';
import { sumApprovedExpenses } from '../utils/analytics';
import { Shift } from '../types/shift';
import { UserAccount } from '../types/user';

const shift: Shift = {
  id: 'S-1',
  locationId: 'LOC01',
  deviceId: 'DEV01',
  cashierId: 'u-1',
  cashierName: 'Ada',
  status: 'open',
  openedAt: '2026-09-03T08:00:00.000Z',
  openingFloat: 0,
};

const cashier = { id: 'u-1', name: 'Ada', role: 'cashier', status: 'active' } as unknown as UserAccount;

describe('Mid-shift expenses are approved on entry', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    useShiftStore.setState({ currentShift: shift });
    useAuthStore.setState({ activeUser: cashier });
    useExpenseStore.setState({ expenses: [], scope: {} });
  });

  it('records the payout as approved and signed by the cashier on shift', async () => {
    const logged = await useExpenseStore.getState().logExpense(1500, 'Supplies', 'Cleaning cloths');

    // The money is already out of the drawer by the time this is typed in — leaving it
    // pending made the till disagree with the drawer until a manager logged in.
    expect(logged.status).toBe('approved');
    expect(logged.reviewedBy).toBe('Ada');
    expect(logged.cashierId).toBe('u-1');
    expect(logged.shiftId).toBe('S-1');
  });

  it('comes off expected cash immediately, with no manager step', async () => {
    await useExpenseStore.getState().logExpense(1500, 'Supplies', 'Cleaning cloths');
    const expenses = useExpenseStore.getState().expenses;

    const recon = calculateShiftReconciliation(0, 10000, sumApprovedExpenses(expenses), 8500);

    expect(recon.expectedCash).toBe(8500);
    expect(recon.variance).toBe(0);
    expect(recon.isVarianceFlagged).toBe(false);
  });

  it('a manager rejection puts the money straight back into expected cash', async () => {
    const logged = await useExpenseStore.getState().logExpense(1500, 'Supplies', 'Not a real payout');
    await useExpenseStore.getState().rejectExpense(logged.id, 'Manager', 'No receipt');

    const expenses = useExpenseStore.getState().expenses;
    expect(expenses[0].status).toBe('rejected');
    expect(expenses[0].rejectionReason).toBe('No receipt');

    // Rejected money is money the cashier is answerable for again: expected cash returns
    // to the full takings, and a drawer short by that amount is now correctly flagged.
    const recon = calculateShiftReconciliation(0, 10000, sumApprovedExpenses(expenses), 8500);
    expect(recon.expectedCash).toBe(10000);
    expect(recon.variance).toBe(-1500);
    expect(recon.isVarianceFlagged).toBe(true);
  });

  it('a manager can restore a rejection, and the deduction comes back', async () => {
    const logged = await useExpenseStore.getState().logExpense(1500, 'Supplies', 'Cleaning cloths');
    await useExpenseStore.getState().rejectExpense(logged.id, 'Manager', 'Checking');
    await useExpenseStore.getState().approveExpense(logged.id, 'Manager');

    const expenses = useExpenseStore.getState().expenses;
    expect(expenses[0].status).toBe('approved');
    expect(sumApprovedExpenses(expenses)).toBe(1500);
  });
});
