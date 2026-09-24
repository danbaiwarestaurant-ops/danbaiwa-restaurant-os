import { describe, expect, it } from 'vitest';
import { calculateAssessment, wageBalance } from '../utils/workforce';

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
});
