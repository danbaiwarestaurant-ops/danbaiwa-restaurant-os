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
import { UserAccount, UserRole } from '../types/user';
import { Bucket } from './period';
import { calculateShiftReconciliation } from './reconciliation';

/**
 * A staff meal is a plate the business gave away. Real food, real cost, but nobody paid
 * for it — so it is not a sale, and it is the one thing on the till that must never reach
 * a revenue figure. Kept as its own predicate so the reason is stated once.
 */
export function isStaffMeal(t: Ticket): boolean {
  return t.tender === 'staff';
}

/**
 * A voided ticket is not revenue, and neither is a staff meal. Every money figure here
 * goes through this — which is the point of it being one function: a new kind of
 * non-revenue ticket is excluded from sales, tender splits, day series, per-cashier
 * rollups and shift reconciliation by this line alone, rather than by remembering to
 * filter it in six places.
 */
export function isRevenueTicket(t: Ticket): boolean {
  return t.status !== 'void' && !isStaffMeal(t);
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
  /** Staff meals issued — plates served, not sales. */
  staffMealCount: number;
  /** What those plates were worth at menu price: a cost line, never revenue. */
  staffMealValue: number;
}

export function summariseTickets(tickets: Ticket[]): SalesTotals {
  const valid = tickets.filter(isRevenueTicket);
  const revenue = valid.reduce((sum, t) => sum + (t.amount || 0), 0);

  // Voided staff meals count once, as voids: a cancelled staff meal is a plate that never
  // left the kitchen, and counting it in both would overstate what the business gave away.
  const voids = tickets.filter((t) => t.status === 'void');
  const staffMeals = tickets.filter((t) => isStaffMeal(t) && t.status !== 'void');

  return {
    ticketCount: valid.length,
    // Was `tickets.length - valid.length`, which is now wrong: with staff meals excluded
    // from `valid`, that subtraction would report every staff meal as a voided sale.
    voidCount: voids.length,
    revenue,
    // Guard the empty case rather than reporting NaN in a KPI card.
    averageTicket: valid.length ? revenue / valid.length : 0,
    staffMealCount: staffMeals.length,
    staffMealValue: staffMeals.reduce((sum, t) => sum + (t.amount || 0), 0),
  };
}

/**
 * Cash is the default reading of a ticket with no tender recorded.
 *
 * Tickets issued before the cash/transfer split existed carry no `tender`, and every one
 * of them was a drawer sale. Treating an absent tender as anything else would quietly
 * remove historic cash from expected cash and flag old shifts as short.
 */
export function isCashTicket(t: Ticket): boolean {
  return (t.tender ?? 'cash') === 'cash';
}

export interface TenderSplit {
  /** All non-void revenue, however it was paid. Staff meals are not in here. */
  total: number;
  /** The part that went into the drawer — the only part a cash count can be checked against. */
  cash: number;
  /** Card and bank transfer. Real revenue, but never in the drawer. */
  transfer: number;
  /**
   * Staff meals at menu value. Reported alongside the split rather than inside it, so a
   * cashier can see what the kitchen gave away without it being added to what they owe.
   */
  staff: number;
}

/** Splits a set of tickets into what hit the drawer and what did not. Voids are excluded. */
export function splitByTender(tickets: Ticket[]): TenderSplit {
  const valid = tickets.filter(isRevenueTicket);
  const total = valid.reduce((sum, t) => sum + (t.amount || 0), 0);
  const cash = valid
    .filter(isCashTicket)
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  // Note that `transfer` stays `total - cash` and stays correct: staff meals never
  // entered `valid`, so they cannot fall through into it the way they would if this
  // subtracted from an all-tickets total.
  const staff = tickets
    .filter((t) => isStaffMeal(t) && t.status !== 'void')
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  return { total, cash, transfer: total - cash, staff };
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

/**
 * Which shift a ticket belongs to, or '' when none claims it.
 *
 * Same rule as `shiftTickets`, asked the other way round: the cashier who took it, inside
 * that shift's open window. A ticket can land outside every shift — issued by an admin who
 * never opened one, or before this device knew about the shift — and those keep their own
 * group rather than being folded into a neighbouring shift's.
 */
export function shiftIdForTicket(ticket: Ticket, shifts: Shift[]): string {
  const at = Date.parse(ticket.createdAt);
  if (Number.isNaN(at)) return '';

  const owner = shifts.find((s) => {
    if (s.cashierId !== ticket.cashierId) return false;
    const from = Date.parse(s.openedAt);
    if (Number.isNaN(from)) return false;
    const to = s.closedAt ? Date.parse(s.closedAt) : Number.POSITIVE_INFINITY;
    return at >= from && at <= to;
  });

  return owner?.id ?? '';
}

/**
 * Pages of tickets that never span two shifts.
 *
 * A page break is forced at every shift boundary, so the shift in progress starts on page
 * one and the shift before it starts on a page of its own. Without this the newest page
 * mixed the current shift's tickets with the tail of somebody else's — and the sidebar is
 * what a cashier checks their own service against.
 *
 * `tickets` must already be in the order they should read (newest first, as the store
 * keeps them). Long shifts still break every `pageSize` tickets.
 */
export function paginateByShift(tickets: Ticket[], shifts: Shift[], pageSize: number): Ticket[][] {
  const pages: Ticket[][] = [];
  let page: Ticket[] = [];
  let pageShiftId: string | null = null;

  for (const t of tickets) {
    const shiftId = shiftIdForTicket(t, shifts);
    if (page.length > 0 && (shiftId !== pageShiftId || page.length >= pageSize)) {
      pages.push(page);
      page = [];
    }
    pageShiftId = shiftId;
    page.push(t);
  }
  if (page.length > 0) pages.push(page);

  return pages;
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

  // Cash only: a card or transfer sale is revenue, but it never reached the drawer, so
  // holding the cashier's count against it would show a shortage they cannot produce.
  return calculateShiftReconciliation(
    shift.openingFloat || 0,
    splitByTender(shiftTickets(tickets, shift)).cash,
    sumApprovedExpenses(shiftExpenses(expenses, shift)),
    shift.countedCash ?? 0
  );
}

export interface StaffSalesRollup {
  /**
   * The staff member who issued these tickets.
   *
   * Named `cashierId` on the stored record and staying that way — it is a Postgres
   * column, a Dexie index and a sync key on every ticket ever written. It has always
   * meant "who rang this up", which is now a cashier or a server. See utils/roles.ts.
   */
  staffId: string;
  name: string;
  /** What they do, so the console can report the sales floor by role. */
  role: UserRole;
  ticketCount: number;
  revenue: number;
  voidCount: number;
}

/**
 * Sales per staff member. Driven by the ticket list, not the staff list, so someone whose
 * account was removed still shows against the tickets they took rather than having their
 * revenue quietly disappear from the totals.
 *
 * Was cashierRollups, back when every person on the roster was a cashier. It now carries
 * the role, which is what lets the console answer "how did the servers do this week"
 * separately from "how did the till do" — the same tickets, asked a different way.
 */
export function staffSalesRollups(tickets: Ticket[], users: UserAccount[]): StaffSalesRollup[] {
  const byId = new Map<string, StaffSalesRollup>();
  const userFor = (id: string) => users.find((u) => u.id === id);

  for (const t of tickets) {
    // Staff meals belong to the person who ate, not the cashier who rang them up — see
    // staffMealRollups. Skipped entirely rather than falling into the else below, which
    // would have recorded a void against a cashier for feeding a colleague: this rollup
    // splits on isRevenueTicket, and a staff meal is now on the same side of it as a
    // void without being one.
    if (isStaffMeal(t)) continue;

    const id = t.cashierId || 'unassigned';
    let row = byId.get(id);
    if (!row) {
      const who = userFor(id);
      row = {
        staffId: id,
        name: who?.name ?? 'Former staff',
        // A ticket from someone no longer on the roster is still a sale, and it was rung
        // up on the floor by definition — filing it as 'cashier' keeps it in the sales
        // reporting it belongs to rather than dropping it into an 'other' bucket.
        role: who?.role ?? 'cashier',
        ticketCount: 0,
        revenue: 0,
        voidCount: 0,
      };
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

export interface StaffMealRollup {
  staffId: string;
  name: string;
  mealCount: number;
  /** Menu value of those meals. */
  value: number;
}

/**
 * Staff meals per employee, for the period the console is showing.
 *
 * The name is taken from the ticket rather than looked up, so the report keeps reading
 * correctly after someone is renamed or leaves — see Ticket.staffName. The roster is only
 * consulted for the older tickets that predate that field.
 *
 * Voided staff meals are excluded: a cancelled meal is one the kitchen never served, and
 * counting it against an employee would be an accusation the record does not support.
 */
export function staffMealRollups(tickets: Ticket[], users: UserAccount[]): StaffMealRollup[] {
  const byId = new Map<string, StaffMealRollup>();

  for (const t of tickets) {
    if (!isStaffMeal(t) || t.status === 'void') continue;

    const id = t.staffId || 'unattributed';
    let row = byId.get(id);
    if (!row) {
      const name =
        t.staffName ||
        users.find((u) => u.id === id)?.name ||
        (id === 'unattributed' ? 'Not recorded' : 'Former staff');
      row = { staffId: id, name, mealCount: 0, value: 0 };
      byId.set(id, row);
    }
    row.mealCount++;
    row.value += t.amount || 0;
  }

  return [...byId.values()].sort((a, b) => b.value - a.value);
}

export interface BucketRollup {
  key: string;
  label: string;
  revenue: number;
  /** The cash half of `revenue` — what should have reached the drawer that day. */
  cash: number;
  /** The card/transfer half of `revenue` — what should have reached the bank. */
  transfer: number;
  expenses: number;
  net: number;
  ticketCount: number;
  /** Staff meals at menu value — outside `revenue`, and outside `net`. */
  staffMeals: number;
  staffMealCount: number;
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

    const inBucket = tickets.filter((t) => within(t.createdAt));
    const soldIn = inBucket.filter(isRevenueTicket);
    const { total: revenue, cash, transfer } = splitByTender(soldIn);
    const spent = sumApprovedExpenses(expenses.filter((e) => within(e.loggedAt)));
    const staff = summariseTickets(inBucket);

    return {
      key: b.key,
      label: b.label,
      revenue,
      cash,
      transfer,
      expenses: spent,
      // Staff meals are deliberately NOT subtracted here. `net` is cash performance —
      // money in less money out — and no money left the business for a staff meal; the
      // food was already bought and already counted as stock. Netting it off would
      // charge the same plate twice. It is reported beside net, not inside it.
      net: revenue - spent,
      ticketCount: soldIn.length,
      staffMeals: staff.staffMealValue,
      staffMealCount: staff.staffMealCount,
    };
  });
}
