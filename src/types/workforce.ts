import { UserRole } from './user';

export interface RolePayConfig {
  id: string;
  role: UserRole;
  metricLabel: string;
  /** Legacy field retained only so older synced rows remain readable. New wage rules have no daily target. */
  targetPerDay?: number;
  nairaPerUnit: number;
  updatedBy: string;
  updatedAt: string;
  accountId?: string;
}

export interface WagePenalty {
  id: string;
  label: string;
  kind: 'fixed';
  value: number;
}

export interface PerformanceReward {
  id: string;
  label: string;
  value: number;
}

export type AssessmentStatus = 'draft' | 'finalized';

export interface StaffAssessment {
  id: string;
  businessDay: string;
  staffId: string;
  staffName: string;
  role: UserRole;
  metricLabel: string;
  output: number;
  /** Legacy fields from the target-based model. New assessments use output and reward rate directly. */
  target?: number;
  performancePercent?: number;
  nairaPerUnit: number;
  grossPay: number;
  penalties: WagePenalty[];
  fixedPenaltyTotal: number;
  rewards?: PerformanceReward[];
  rewardTotal?: number;
  netPay: number;
  note?: string;
  status: AssessmentStatus;
  finalizedAt?: string;
  reopenedAt?: string;
  reopenReason?: string;
  recordedBy: string;
  recordedByName?: string;
  recordedAt: string;
  accountId?: string;
  updatedAt?: string;
}

export type WageLedgerKind = 'payment' | 'debt_forgiveness' | 'manual_adjustment';

export interface WageLedgerEntry {
  id: string;
  staffId: string;
  staffName: string;
  businessDay: string;
  kind: WageLedgerKind;
  /** Payment reduces the balance. Forgiveness/adjustment may be positive or negative. */
  amount: number;
  note: string;
  recordedBy: string;
  recordedByName?: string;
  recordedAt: string;
  accountId?: string;
  updatedAt?: string;
}

export function assessmentId(day: string, staffId: string): string {
  return `${day}_${staffId}`;
}
