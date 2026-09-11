/**
 * staffMeals.test.ts
 *
 * A staff meal is a plate the kitchen served and nobody paid for.
 *
 * The whole feature rests on one rule — it is never revenue — and the cost of getting it
 * wrong is silent in both directions: counted as a sale, the books report money the
 * business never took; counted as cash, every cashier who feeds a colleague comes up
 * short at close-out and is asked to account for food. Neither shows up as an error, so
 * they are pinned here.
 */

import { describe, it, expect } from 'vitest';
import {
  isRevenueTicket,
  isStaffMeal,
  isCashTicket,
  splitByTender,
  summariseTickets,
  staffSalesRollups,
  staffMealRollups,
  reconcileShift,
  bucketBreakdown,
} from '../utils/analytics';
import { periodBuckets, periodFor } from '../utils/period';
import { Ticket } from '../types/ticket';
import { Shift } from '../types/shift';
import { UserAccount } from '../types/user';

let seq = 0;
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: `T-${++seq}`,
  locationId: 'LOC01',
  deviceId: 'DEV01',
  localSeq: seq,
  amount: 1000,
  currency: '₦',
  status: 'paid',
  tender: 'cash',
  createdAt: '2026-09-10T12:00:00.000Z',
  cashierId: 'u-ada',
  qrPayload: '',
  ...over,
});

const staffMeal = (over: Partial<Ticket> = {}) =>
  ticket({ tender: 'staff', staffId: 'u-bola', staffName: 'Bola', ...over });

describe('a staff meal is not a sale', () => {
  it('is excluded from revenue', () => {
    expect(isStaffMeal(staffMeal())).toBe(true);
    expect(isRevenueTicket(staffMeal())).toBe(false);
    expect(isRevenueTicket(ticket())).toBe(true);
  });

  it('is not cash, so it can never be asked for in a drawer count', () => {
    expect(isCashTicket(staffMeal())).toBe(false);
  });

  it('keeps sales totals to what was actually sold', () => {
    const totals = summariseTickets([
      ticket({ amount: 1000 }),
      ticket({ amount: 500 }),
      staffMeal({ amount: 800 }),
    ]);

    expect(totals.revenue).toBe(1500);
    expect(totals.ticketCount).toBe(2);
    expect(totals.averageTicket).toBe(750);
    expect(totals.staffMealCount).toBe(1);
    expect(totals.staffMealValue).toBe(800);
  });

  it('does not report staff meals as voided sales', () => {
    // The regression this guards: voidCount was `tickets.length - valid.length`, and with
    // staff meals newly outside `valid` that subtraction would have counted every one of
    // them as a void — putting a fault on the cashier's record for feeding a colleague.
    const totals = summariseTickets([ticket(), staffMeal(), staffMeal()]);
    expect(totals.voidCount).toBe(0);
    expect(totals.staffMealCount).toBe(2);
  });

  it('counts a voided staff meal once, as a void', () => {
    const totals = summariseTickets([staffMeal({ status: 'void' })]);
    expect(totals.voidCount).toBe(1);
    expect(totals.staffMealCount).toBe(0);
    expect(totals.staffMealValue).toBe(0);
  });
});

describe('the tender split', () => {
  it('keeps staff meals out of the total, and out of transfer', () => {
    // The trap: `transfer` is derived as `total - cash`, so a staff meal that reached the
    // total would silently be reported as a card sale — revenue that never existed,
    // filed against money that should have reached the bank.
    const split = splitByTender([
      ticket({ amount: 1000, tender: 'cash' }),
      ticket({ amount: 400, tender: 'transfer' }),
      staffMeal({ amount: 700 }),
    ]);

    expect(split.total).toBe(1400);
    expect(split.cash).toBe(1000);
    expect(split.transfer).toBe(400);
    expect(split.staff).toBe(700);
  });

  it('reports staff meals with no sales at all', () => {
    const split = splitByTender([staffMeal({ amount: 250 })]);
    expect(split.total).toBe(0);
    expect(split.cash).toBe(0);
    expect(split.transfer).toBe(0);
    expect(split.staff).toBe(250);
  });
});

describe('close-out', () => {
  const shift: Shift = {
    id: 's-1',
    locationId: 'LOC01',
    deviceId: 'DEV01',
    cashierId: 'u-ada',
    cashierName: 'Ada',
    status: 'open',
    openedAt: '2026-09-10T08:00:00.000Z',
    openingFloat: 0,
  };

  it('never asks a cashier to produce cash for a meal nobody paid for', () => {
    const recon = reconcileShift(
      shift,
      [ticket({ amount: 2000, tender: 'cash' }), staffMeal({ amount: 900 })],
      []
    );

    expect(recon.expectedCash).toBe(2000);
  });
});

describe('per-employee reporting', () => {
  const users = [
    { id: 'u-ada', name: 'Ada' },
    { id: 'u-bola', name: 'Bola' },
  ] as UserAccount[];

  it('does not credit the cashier who rang it with revenue for it', () => {
    const rollups = staffSalesRollups(
      [ticket({ cashierId: 'u-ada', amount: 1000 }), staffMeal({ cashierId: 'u-ada', amount: 900 })],
      users
    );

    expect(rollups[0].revenue).toBe(1000);
    expect(rollups[0].ticketCount).toBe(1);
    expect(rollups[0].voidCount).toBe(0);
  });

  it('groups meals by the employee who ate, not the cashier who issued', () => {
    const rows = staffMealRollups(
      [
        staffMeal({ cashierId: 'u-ada', staffId: 'u-bola', staffName: 'Bola', amount: 800 }),
        staffMeal({ cashierId: 'u-ada', staffId: 'u-bola', staffName: 'Bola', amount: 200 }),
        staffMeal({ cashierId: 'u-bola', staffId: 'u-ada', staffName: 'Ada', amount: 300 }),
        ticket({ amount: 5000 }),
      ],
      users
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ staffId: 'u-bola', name: 'Bola', mealCount: 2, value: 1000 });
    expect(rows[1]).toMatchObject({ staffId: 'u-ada', name: 'Ada', mealCount: 1, value: 300 });
  });

  it('keeps naming someone after they have left the roster', () => {
    // The name is carried on the ticket for exactly this: a report that degrades into a
    // column of "Unknown" as staff turn over is not a record anyone can act on.
    const rows = staffMealRollups([staffMeal({ staffId: 'u-gone', staffName: 'Chidi' })], []);
    expect(rows[0].name).toBe('Chidi');
  });

  it('excludes voided meals from an employee\'s tally', () => {
    const rows = staffMealRollups([staffMeal({ status: 'void', amount: 800 })], users);
    expect(rows).toHaveLength(0);
  });
});

describe('the period breakdown', () => {
  it('reports staff meals beside net rather than inside it', () => {
    const day = periodFor('day', new Date(2026, 8, 10));
    const rows = bucketBreakdown(
      [
        ticket({ amount: 1000, createdAt: new Date(2026, 8, 10, 12).toISOString() }),
        staffMeal({ amount: 600, createdAt: new Date(2026, 8, 10, 13).toISOString() }),
      ],
      [],
      periodBuckets(day)
    );

    const total = rows.reduce(
      (acc, r) => ({
        revenue: acc.revenue + r.revenue,
        net: acc.net + r.net,
        staffMeals: acc.staffMeals + r.staffMeals,
        staffMealCount: acc.staffMealCount + r.staffMealCount,
        ticketCount: acc.ticketCount + r.ticketCount,
      }),
      { revenue: 0, net: 0, staffMeals: 0, staffMealCount: 0, ticketCount: 0 }
    );

    expect(total.revenue).toBe(1000);
    // No money left the business for the meal, so net is untouched by it.
    expect(total.net).toBe(1000);
    expect(total.staffMeals).toBe(600);
    expect(total.staffMealCount).toBe(1);
    expect(total.ticketCount).toBe(1);
  });
});
