import { describe, expect, it } from 'vitest';
import { calculateAssessment, wageBalance, wageStatement } from '../utils/workforce';
import { periodFor } from '../utils/period';

describe('performance wage calculation', () => {
  it('deducts fixed penalties and allows a negative wage', () => {
    const result = calculateAssessment({
      output: 8,
      nairaPerUnit: 500,
      penalties: [
        { id: '1', label: 'Late', kind: 'fixed', value: 5000 },
      ],
    });
    expect(result.grossPay).toBe(4000);
    expect(result.fixedPenaltyTotal).toBe(5000);
    expect(result.netPay).toBe(-1000);
  });

  it('adds configured performance rewards before fixed penalties', () => {
    const result = calculateAssessment({
      output: 5,
      nairaPerUnit: 200,
      rewards: [{ id: 'service', label: 'Customer praise', value: 500 }],
      penalties: [{ id: 'late', label: 'Late', kind: 'fixed', value: 100 }],
    });
    expect(result).toEqual({ grossPay: 1000, rewardTotal: 500, fixedPenaltyTotal: 100, netPay: 1400 });
  });

  it('carries debt through the ledger balance', () => {
    const assessment = { status: 'finalized', netPay: -500 } as any;
    const next = { status: 'finalized', netPay: 2000 } as any;
    expect(wageBalance([assessment, next], [])).toBe(1500);
  });

  it('reconciles an itemized statement across trading-day boundaries and excludes drafts', () => {
    const period = periodFor('day', new Date(2026, 9, 5, 10), 1, 8);
    const wages = [
      { id: 'old', businessDay: '2026-10-04', status: 'finalized', grossPay: 1000, netPay: 1000 },
      { id: 'today', businessDay: '2026-10-05', status: 'finalized', grossPay: 2000, rewardTotal: 500, fixedPenaltyTotal: 200, netPay: 2300 },
      { id: 'draft', businessDay: '2026-10-05', status: 'draft', netPay: 99999 },
      { id: 'future', businessDay: '2026-10-06', status: 'finalized', netPay: 100 },
    ] as any;
    const entries = [
      { id: 'old-payment', businessDay: '2026-10-04', kind: 'payment', amount: 200, note: '' },
      { id: 'meal', businessDay: '2026-10-05', kind: 'manual_adjustment', amount: -500, note: 'Staff meal deduction: food' },
      { id: 'adjust', businessDay: '2026-10-05', kind: 'debt_forgiveness', amount: 100, note: 'Approved' },
      { id: 'payment', businessDay: '2026-10-05', kind: 'payment', amount: -1000, note: 'Paid' },
    ] as any;
    expect(wageStatement(wages, entries.map((row: any) => ({ recordedAt: '2026-10-05T12:00:00.000Z', ...row })), period)).toMatchObject({ opening: 800, base: 2000, bonuses: 500, penalties: 200, netWages: 2300, mealDeductions: 500, adjustments: 100, payments: 1000, closing: 1700, current: 1800, draftCount: 1 });
  });
});
