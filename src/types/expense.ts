export type ExpenseStatus = 'pending' | 'approved' | 'rejected';

export interface Expense {
  id: string; // client UUID
  shiftId: string;
  cashierId: string;
  cashierName: string;
  amount: number;
  category: string;
  description: string;
  status: ExpenseStatus;
  loggedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  /** Server-authoritative, set by the Postgres trigger — used for last-write-wins
   *  merges when reconciling remote changes into the local copy. */
  updatedAt?: string;
}
