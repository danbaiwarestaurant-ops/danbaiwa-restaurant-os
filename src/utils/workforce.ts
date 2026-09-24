import { PerformanceReward, StaffAssessment, WageLedgerEntry, WagePenalty } from '../types/workforce';

export function calculateAssessment(input: {
  output: number;
  nairaPerUnit: number;
  penalties: WagePenalty[];
  rewards?: PerformanceReward[];
}) {
  const output = Math.max(0, Number(input.output) || 0);
  const rate = Math.max(0, Number(input.nairaPerUnit) || 0);
  const grossPay = output * rate;
  const fixedPenaltyTotal = input.penalties
    .filter((p) => p.kind === 'fixed')
    .reduce((sum, p) => sum + Math.max(0, Number(p.value) || 0), 0);
  const rewardTotal = (input.rewards || []).reduce((sum, reward) => sum + Math.max(0, Number(reward.value) || 0), 0);
  const netPay = grossPay + rewardTotal - fixedPenaltyTotal;
  return { grossPay, fixedPenaltyTotal, rewardTotal, netPay };
}

/** Positive means the restaurant owes the employee; negative means employee debt. */
export function wageBalance(assessments: StaffAssessment[], ledger: WageLedgerEntry[]): number {
  const earned = assessments
    .filter((a) => a.status === 'finalized')
    .reduce((sum, a) => sum + a.netPay, 0);
  const adjustments = ledger.reduce((sum, row) => {
    if (row.kind === 'payment') return sum - Math.abs(row.amount);
    return sum + row.amount;
  }, 0);
  return earned + adjustments;
}
