import { describe, it, expect } from 'vitest';
import { calculateShiftReconciliation } from '../utils/reconciliation';

describe('Shift Cash Reconciliation & Variance Math (NFR17)', () => {
  it('should compute exact expected cash: float + cashTickets - approvedExpenses', () => {
    const openingFloat = 5000;
    const totalCashTickets = 12500;
    const totalApprovedExpenses = 1500;
    const countedCash = 16000;

    const result = calculateShiftReconciliation(
      openingFloat,
      totalCashTickets,
      totalApprovedExpenses,
      countedCash
    );

    expect(result.expectedCash).toBe(16000); // 5000 + 12500 - 1500 = 16000
    expect(result.variance).toBe(0);
    expect(result.isVarianceFlagged).toBe(false);
  });

  it('should detect and flag cash shortage (negative variance)', () => {
    const result = calculateShiftReconciliation(5000, 10000, 1000, 13500);
    // expected = 5000 + 10000 - 1000 = 14000
    // counted = 13500
    // variance = -500
    expect(result.expectedCash).toBe(14000);
    expect(result.variance).toBe(-500);
    expect(result.isVarianceFlagged).toBe(true);
  });

  it('should detect and flag cash surplus (positive variance)', () => {
    const result = calculateShiftReconciliation(5000, 10000, 1000, 14500);
    expect(result.expectedCash).toBe(14000);
    expect(result.variance).toBe(500);
    expect(result.isVarianceFlagged).toBe(true);
  });
});
