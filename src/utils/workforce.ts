import { PerformanceReward, StaffAssessment, WageLedgerEntry, WagePenalty } from '../types/workforce';
import { Period, periodContains } from './period';
import { businessDayKey } from './shiftDay';

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

/** Recorded business-day labels are already trading dates. Do not shift them again. */
export function wageStatement(assessments: StaffAssessment[], ledger: WageLedgerEntry[], period: Period) {
  const startDay = businessDayKey(period.start, period.businessDayStartHour);
  const finalized = assessments.filter(a => a.status === 'finalized');
  const wages = finalized.filter(a => periodContains(period, a.businessDay));
  const entries = ledger.filter(row => periodContains(period, row.businessDay));
  const opening = wageBalance(finalized.filter(a => a.businessDay < startDay), ledger.filter(row => row.businessDay < startDay));
  const base = wages.reduce((sum, a) => sum + a.grossPay, 0);
  const bonuses = wages.reduce((sum, a) => sum + (a.rewardTotal ?? (a.rewards || []).reduce((n, r) => n + r.value, 0)), 0);
  const penalties = wages.reduce((sum, a) => sum + a.fixedPenaltyTotal, 0);
  const netWages = wages.reduce((sum, a) => sum + a.netPay, 0);
  const payments = entries.filter(row => row.kind === 'payment').reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const mealDeductions = entries.filter(row => row.kind === 'manual_adjustment' && row.amount < 0 && row.note.startsWith('Staff meal deduction:'))
    .reduce((sum, row) => sum - row.amount, 0);
  const adjustments = entries.filter(row => row.kind !== 'payment').reduce((sum, row) => sum + row.amount, 0) + mealDeductions;
  return { opening, base, bonuses, penalties, netWages, payments, mealDeductions, adjustments,
    closing: opening + netWages + adjustments - mealDeductions - payments,
    current: wageBalance(assessments, ledger), wages: wages.sort((a, b) => a.businessDay.localeCompare(b.businessDay)),
    entries: entries.sort((a, b) => a.businessDay.localeCompare(b.businessDay) || a.recordedAt.localeCompare(b.recordedAt)),
    draftCount: assessments.filter(a => a.status === 'draft' && periodContains(period, a.businessDay)).length };
}
