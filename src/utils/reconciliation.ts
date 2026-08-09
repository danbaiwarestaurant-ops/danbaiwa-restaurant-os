import { ShiftReconciliationResult } from '../types/shift';

/**
 * Calculates expected cash and variance for a shift.
 * expected_cash = openingFloat + totalCashTickets - totalApprovedExpenses
 * variance = countedCash - expectedCash
 */
export function calculateShiftReconciliation(
  openingFloat: number,
  totalCashTickets: number,
  totalApprovedExpenses: number,
  countedCash: number
): ShiftReconciliationResult {
  const safeFloat = Math.max(0, openingFloat || 0);
  const safeTickets = Math.max(0, totalCashTickets || 0);
  const safeExpenses = Math.max(0, totalApprovedExpenses || 0);
  const safeCounted = Math.max(0, countedCash || 0);

  const expectedCash = safeFloat + safeTickets - safeExpenses;
  const variance = safeCounted - expectedCash;
  const isVarianceFlagged = Math.abs(variance) > 0.01;

  return {
    openingFloat: safeFloat,
    totalCashTickets: safeTickets,
    totalApprovedExpenses: safeExpenses,
    expectedCash,
    countedCash: safeCounted,
    variance,
    isVarianceFlagged,
  };
}
