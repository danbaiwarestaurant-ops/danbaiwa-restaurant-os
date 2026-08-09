export type ShiftStatus = 'open' | 'closed';

export interface Shift {
  id: string; // client UUID
  locationId: string;
  deviceId: string;
  cashierId: string;
  cashierName: string;
  status: ShiftStatus;
  openedAt: string;
  closedAt?: string;
  openingFloat: number;
  expectedCash?: number;
  countedCash?: number;
  variance?: number; // countedCash - expectedCash
  acknowledgedByManager?: string;
  notes?: string;
}

export interface ShiftReconciliationResult {
  openingFloat: number;
  totalCashTickets: number;
  totalApprovedExpenses: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  isVarianceFlagged: boolean;
}
