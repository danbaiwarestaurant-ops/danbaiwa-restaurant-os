/**
 * analytics.ts
 *
 * Every number the Manager Console reports, as pure functions.
 *
 * Deliberately free of React and of any store import: the console's views stay
 * presentational and these can be unit-tested directly against fixtures. A rollup that
 * silently miscounts (a voided ticket included in revenue, a day with no sales dropped
 * from a series so the chart shifts) is not the kind of bug a screenshot catches.
 */

import { Ticket } from '../types/ticket';
import { Expense } from '../types/expense';
import { Shift, ShiftReconciliationResult } from '../types/shift';
import { UserAccount } from '../types/user';
import { Bucket } from './period';
import { calculateShiftReconciliation } from './reconciliation';

/** A voided ticket is not revenue. Every money figure here goes through this. */
export function isRevenueTicket(t: Ticket): boolean {
  return t.status !== 'void';
}

/** Local (not UTC) YYYY-MM-DD — the day boundary a restaurant actually works to. */
export function dayKey(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export interface SalesTotals {
  ticketCount: number;
  voidCount: number;
  revenue: number;
  averageTicket: number;
}

export function summariseTickets(tickets: Ticket[]): SalesTotals {
  const valid = tickets.filter(isRevenueTicket);
  const revenue = valid.reduce((sum, t) => sum + (t.amount || 0), 0);
  return {
    ticketCount: valid.length,
    voidCount: tickets.length - valid.length,
    revenue,
    // Guard the empty case rather than reporting NaN in a KPI card.
    averageTicket: valid.length ? revenue / valid.length : 0,
  };
}

export function sumApprovedExpenses(expenses: Expense[]): number {
  return expenses
    .filter((e) => e.status === 'approved')
    .reduce((sum, e) => sum + (e.amount || 0), 0);
}

export interface DayPoint {
  /** Bucket key — YYYY-MM-DD for daily points, YYYY-MM for monthly. */
  day: string;
  /** Axis label, e.g. "Mon", "17", "Aug". */
  label: string;
  revenue: number;
  ticketCount: number;
}

/**
 * Revenue per bucket of a reporting period (see period.ts).
 *
 * Generalises the fixed 7-day series so the same chart serves a week, a month or a year.
 * Iterates the buckets, not the tickets, for the reason spelled out in `periodBuckets`:
 * a quiet day must be a zero column rather than a missing one.
 */
export function bucketRevenue(tickets: Ticket[], buckets: Bucket[]): DayPoint[] {
  return buckets.map((b) => {
    const from = b.start.getTime();
    const to = b.end.getTime();
    const inBucket = tickets.filter((t) => {
      if (!isRevenueTicket(t)) return false;
      const at = Date.parse(t.createdAt);
      return !Number.isNaN(at) && at >= from && at < to;
    });
    return {
      day: b.key,
      label: b.label,
      revenue: inBucket.reduce((sum, t) => sum + (t.amount || 0), 0),
      ticketCount: inBucket.length,
    };
  });
}

/**
 * The tickets that belong to one shift.
 *
 * A `Ticket` carries no `shiftId` — the only link to a shift is who took it and when — so
 * a shift's takings are its cashier's tickets inside its open window. An open shift runs to
 * now; a closed one stops at `closedAt`.
 *
 * This matters more than it looks: close-out previously reconciled against *every ticket in
 * the store*, which for an admin is every cashier's tickets for all time. Expected cash was
 * therefore the account's lifetime revenue, so the variance recorded against the shift was
 * meaningless and every closed shift was flagged.
 */
export function shiftTickets(tickets: Ticket[], shift: Pick<Shift, 'cashierId' | 'openedAt' | 'closedAt'>): Ticket[] {
  const from = Date.parse(shift.openedAt);
  const to = shift.closedAt ? Date.parse(shift.closedAt) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(from)) return [];

  return tickets.filter((t) => {
    if (t.cashierId !== shift.cashierId) return false;
    const at = Date.parse(t.createdAt);
    return !Number.isNaN(at) && at >= from && at <= to;
  });
}

/** The approved expenses charged to one shift. */
export function shiftExpenses(expenses: Expense[], shift: Pick<Shift, 'id'>): Expense[] {
  return expenses.filter((e) => e.shiftId === shift.id);
}

/**
 * What a shift reconciles to.
 *
 * For a closed shift the figures recorded at close-out win: they are what the cashier was
 * actually held to, and recomputing them later would silently rewrite history the moment a
 * ticket is voided or an expense approved after the fact.
 *
 * For an open shift there is nothing recorded yet, so it is derived live from the shift's
 * own tickets and expenses.
 */
export function reconcileShift(
  shift: Shift,
  tickets: Ticket[],
  expenses: Expense[]
): ShiftReconciliationResult {
  if (shift.status === 'closed' && shift.countedCash !== undefined && shift.expectedCash !== undefined) {
    const variance = shift.variance ?? shift.countedCash - shift.expectedCash;
    return {
      openingFloat: shift.openingFloat || 0,
      // Backs out the sales figure the close-out actually used, so the panel's rows still
      // add up to the expected total it recorded.
      totalCashTickets: Math.max(0, shift.expectedCash - (shift.openingFloat || 0) + sumApprovedExpenses(shiftExpenses(expenses, shift))),
      totalApprovedExpenses: sumApprovedExpenses(shiftExpenses(expenses, shift)),
      expectedCash: shift.expectedCash,
      countedCash: shift.countedCash,
      variance,
      isVarianceFlagged: Math.abs(variance) > 0.01,
    };
  }

  return calculateShiftReconciliation(
    shift.openingFloat || 0,
    summariseTickets(shiftTickets(tickets, shift)).revenue,
    sumApprovedExpenses(shiftExpenses(expenses, shift)),
    shift.countedCash ?? 0
  );
}

export interface CashierRollup {
  cashierId: string;
  name: string;
  ticketCount: number;
  revenue: number;
  voidCount: number;
}

/**
 * Per-cashier performance. Driven by the ticket list, not the staff list, so a cashier
 * whose account was removed still shows against the tickets they took rather than having
 * their revenue quietly disappear from the totals.
 */
export function cashierRollups(tickets: Ticket[], users: UserAccount[]): CashierRollup[] {
  const byId = new Map<string, CashierRollup>();
  const nameFor = (id: string) => users.find((u) => u.id === id)?.name ?? 'Unknown cashier';

  for (const t of tickets) {
    const id = t.cashierId || 'unassigned';
    let row = byId.get(id);
    if (!row) {
      row = { cashierId: id, name: nameFor(id), ticketCount: 0, revenue: 0, voidCount: 0 };
      byId.set(id, row);
    }
    if (isRevenueTicket(t)) {
      row.ticketCount++;
      row.revenue += t.amount || 0;
    } else {
      row.voidCount++;
    }
  }

  return [...byId.values()].sort((a, b) => b.revenue - a.revenue);
}

export interface BucketRollup {
  key: string;
  label: string;
  revenue: number;
  expenses: number;
  net: number;
  ticketCount: number;
}

/**
 * Revenue, approved expenses and net for each bucket of a period — days within a week or
 * month, months within a year.
 *
 * Driven by the buckets rather than by grouping the records, so a day (or month) that
 * traded nothing still appears as a zero row. A manager scanning for the quiet stretch
 * needs to see it, and a table that silently omits it reads as though every day earned.
 */
export function bucketBreakdown(
  tickets: Ticket[],
  expenses: Expense[],
  buckets: Bucket[]
): BucketRollup[] {
  return buckets.map((b) => {
    const from = b.start.getTime();
    const to = b.end.getTime();
    const within = (iso: string) => {
      const t = Date.parse(iso);
      return !Number.isNaN(t) && t >= from && t < to;
    };

    const soldIn = tickets.filter((t) => isRevenueTicket(t) && within(t.createdAt));
    const revenue = soldIn.reduce((sum, t) => sum + (t.amount || 0), 0);
    const spent = sumApprovedExpenses(expenses.filter((e) => within(e.loggedAt)));

    return {
      key: b.key,
      label: b.label,
      revenue,
      expenses: spent,
      net: revenue - spent,
      ticketCount: soldIn.length,
    };
  });
}
