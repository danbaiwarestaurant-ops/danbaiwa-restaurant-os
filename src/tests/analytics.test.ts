import { describe, it, expect } from 'vitest';
import {
  summariseTickets, sumApprovedExpenses, bucketRevenue, bucketBreakdown,
  cashierRollups, shiftTickets, shiftExpenses, reconcileShift, dayKey,
} from '../utils/analytics';
import { periodFor, periodBuckets } from '../utils/period';
import { Ticket } from '../types/ticket';
import { Expense } from '../types/expense';
import { Shift } from '../types/shift';
import { UserAccount } from '../types/user';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: over.id ?? `T-${Math.random().toString(36).slice(2, 8)}`,
    locationId: 'LOC01',
    deviceId: 'DEV01',
    localSeq: 1,
    amount: 1000,
    currency: '₦',
    status: 'paid',
    cashierId: 'c1',
    createdAt: '2026-08-30T12:00:00.000Z',
    qrPayload: 'q',
    ...over,
  };
}

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: over.id ?? `E-${Math.random().toString(36).slice(2, 8)}`,
    shiftId: 's1',
    cashierId: 'c1',
    cashierName: 'Cashier One',
    amount: 500,
    category: 'Supplies',
    description: 'thing',
    status: 'approved',
    loggedAt: '2026-08-30T12:00:00.000Z',
    ...over,
  };
}

const users: UserAccount[] = [
  { id: 'c1', name: 'Amina Yusuf', email: 'a@x.com', username: 'a', pinHash: 'h', pinSalt: 's', role: 'cashier', createdAt: '', status: 'active' },
  { id: 'c2', name: 'Musa Bello', email: 'm@x.com', username: 'm', pinHash: 'h', pinSalt: 's', role: 'cashier', createdAt: '', status: 'active' },
];

describe('summariseTickets', () => {
  it('excludes voided tickets from revenue and count, but reports them', () => {
    const totals = summariseTickets([
      ticket({ amount: 1000 }),
      ticket({ amount: 500 }),
      ticket({ amount: 9999, status: 'void' }),
    ]);
    expect(totals.revenue).toBe(1500);
    expect(totals.ticketCount).toBe(2);
    expect(totals.voidCount).toBe(1);
  });

  it('counts a collected ticket as revenue — collection is fulfilment, not cancellation', () => {
    expect(summariseTickets([ticket({ amount: 800, status: 'collected' })]).revenue).toBe(800);
  });

  it('returns zero rather than NaN for an average over no tickets', () => {
    expect(summariseTickets([]).averageTicket).toBe(0);
    expect(summariseTickets([ticket({ status: 'void' })]).averageTicket).toBe(0);
  });
});

describe('sumApprovedExpenses', () => {
  it('counts only approved expenses', () => {
    const total = sumApprovedExpenses([
      expense({ amount: 100, status: 'approved' }),
      expense({ amount: 200, status: 'pending' }),
      expense({ amount: 400, status: 'rejected' }),
    ]);
    expect(total).toBe(100);
  });
});

describe('bucketRevenue', () => {
  // Week of Mon 24 – Sun 30 Aug 2026.
  const week = periodFor('week', new Date(2026, 7, 26));
  const buckets = periodBuckets(week);

  it('always returns one point per bucket, including days with no sales', () => {
    const series = bucketRevenue([ticket({ createdAt: new Date(2026, 7, 26, 10).toISOString() })], buckets);
    expect(series).toHaveLength(7);
    // A quiet day must be a zero, not a missing point — otherwise every later point shifts
    // left and the chart shows the right total against the wrong day.
    expect(series.filter((p) => p.revenue === 0)).toHaveLength(6);
  });

  it('attributes each ticket to its own local day and excludes voids', () => {
    const series = bucketRevenue(
      [
        ticket({ amount: 100, createdAt: new Date(2026, 7, 25, 9).toISOString() }),
        ticket({ amount: 250, createdAt: new Date(2026, 7, 26, 9).toISOString() }),
        ticket({ amount: 999, status: 'void', createdAt: new Date(2026, 7, 26, 9).toISOString() }),
      ],
      buckets
    );
    expect(series[1].revenue).toBe(100); // Tuesday
    expect(series[2].revenue).toBe(250); // Wednesday, voided one excluded
  });

  it('puts a ticket at 23:59 in that day, not the next', () => {
    const series = bucketRevenue(
      [ticket({ amount: 400, createdAt: new Date(2026, 7, 26, 23, 59, 59).toISOString() })],
      buckets
    );
    expect(series[2].revenue).toBe(400);
    expect(series[3].revenue).toBe(0);
  });

  it('rolls a year up into twelve monthly points', () => {
    const year = periodBuckets(periodFor('year', new Date(2026, 0, 1)));
    const series = bucketRevenue(
      [
        ticket({ amount: 500, createdAt: new Date(2026, 0, 9).toISOString() }),
        ticket({ amount: 700, createdAt: new Date(2026, 11, 9).toISOString() }),
      ],
      year
    );
    expect(series).toHaveLength(12);
    expect(series[0].revenue).toBe(500);
    expect(series[11].revenue).toBe(700);
  });
});

describe('bucketBreakdown', () => {
  const buckets = periodBuckets(periodFor('year', new Date(2026, 0, 1)));

  it('nets approved expenses against the bucket they were logged in', () => {
    const rows = bucketBreakdown(
      [ticket({ amount: 1000, createdAt: new Date(2026, 7, 10).toISOString() })],
      [
        expense({ amount: 250, status: 'approved', loggedAt: new Date(2026, 7, 12).toISOString() }),
        expense({ amount: 999, status: 'pending', loggedAt: new Date(2026, 7, 12).toISOString() }),
      ],
      buckets
    );
    expect(rows[7]).toMatchObject({ key: '2026-08', revenue: 1000, expenses: 250, net: 750, ticketCount: 1 });
  });

  it('keeps a bucket that traded nothing rather than dropping it', () => {
    const rows = bucketBreakdown([], [], buckets);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.revenue === 0 && r.ticketCount === 0)).toBe(true);
  });

  it('can go negative when expenses outrun revenue', () => {
    const rows = bucketBreakdown(
      [ticket({ amount: 100, createdAt: new Date(2026, 2, 3).toISOString() })],
      [expense({ amount: 400, status: 'approved', loggedAt: new Date(2026, 2, 4).toISOString() })],
      buckets
    );
    expect(rows[2].net).toBe(-300);
  });
});

describe('cashierRollups', () => {
  it('splits revenue and voids per cashier, ranked by revenue', () => {
    const rows = cashierRollups(
      [
        ticket({ cashierId: 'c1', amount: 1000 }),
        ticket({ cashierId: 'c1', amount: 500 }),
        ticket({ cashierId: 'c2', amount: 2000 }),
        ticket({ cashierId: 'c1', amount: 300, status: 'void' }),
      ],
      users
    );
    expect(rows[0]).toMatchObject({ cashierId: 'c2', revenue: 2000, ticketCount: 1, voidCount: 0 });
    expect(rows[1]).toMatchObject({ cashierId: 'c1', revenue: 1500, ticketCount: 2, voidCount: 1 });
  });

  it('still reports tickets whose cashier account no longer exists', () => {
    // Deleting a staff account must not make their revenue vanish from the totals.
    const rows = cashierRollups([ticket({ cashierId: 'ghost', amount: 700 })], users);
    expect(rows[0].revenue).toBe(700);
    expect(rows[0].name).toBe('Unknown cashier');
  });
});

describe('date keys', () => {
  it('uses local calendar days, not UTC', () => {
    const d = new Date(2026, 0, 5, 23, 30);
    expect(dayKey(d)).toBe('2026-01-05');
  });
});

function shift(over: Partial<Shift> = {}): Shift {
  return {
    id: over.id ?? 's1',
    locationId: 'LOC01',
    deviceId: 'DEV01',
    cashierId: 'c1',
    cashierName: 'Amina Yusuf',
    status: 'open',
    openedAt: new Date(2026, 7, 30, 8).toISOString(),
    openingFloat: 0,
    ...over,
  };
}

describe('shiftTickets', () => {
  const s = shift({
    cashierId: 'c1',
    openedAt: new Date(2026, 7, 30, 8).toISOString(),
    closedAt: new Date(2026, 7, 30, 16).toISOString(),
  });

  it('takes only the shift cashier’s tickets inside the shift window', () => {
    const rows = shiftTickets(
      [
        ticket({ id: 'in', cashierId: 'c1', createdAt: new Date(2026, 7, 30, 10).toISOString() }),
        ticket({ id: 'other-cashier', cashierId: 'c2', createdAt: new Date(2026, 7, 30, 10).toISOString() }),
        ticket({ id: 'before', cashierId: 'c1', createdAt: new Date(2026, 7, 30, 7).toISOString() }),
        ticket({ id: 'after', cashierId: 'c1', createdAt: new Date(2026, 7, 30, 17).toISOString() }),
        ticket({ id: 'yesterday', cashierId: 'c1', createdAt: new Date(2026, 7, 29, 10).toISOString() }),
      ],
      s
    );
    expect(rows.map((t) => t.id)).toEqual(['in']);
  });

  it('runs to now for a shift that is still open', () => {
    const open = shift({ closedAt: undefined });
    const rows = shiftTickets(
      [ticket({ cashierId: 'c1', createdAt: new Date(2026, 7, 30, 23).toISOString() })],
      open
    );
    expect(rows).toHaveLength(1);
  });
});

describe('reconcileShift', () => {
  it('bounds expected cash to the shift, not to every ticket ever taken', () => {
    // The bug this guards: close-out summed the whole ticket store, so expected cash was
    // the account's lifetime revenue and every drawer came out short by the difference.
    const s = shift({ id: 's1', cashierId: 'c1', openingFloat: 0 });
    const tickets = [
      ticket({ cashierId: 'c1', amount: 1000, createdAt: new Date(2026, 7, 30, 9).toISOString() }),
      ticket({ cashierId: 'c1', amount: 500, createdAt: new Date(2026, 7, 30, 10).toISOString() }),
      // Another cashier, and a ticket from before the shift opened. Neither is this drawer.
      ticket({ cashierId: 'c2', amount: 9999, createdAt: new Date(2026, 7, 30, 9).toISOString() }),
      ticket({ cashierId: 'c1', amount: 7777, createdAt: new Date(2026, 7, 29, 9).toISOString() }),
    ];
    const expenses = [
      expense({ shiftId: 's1', amount: 200, status: 'approved' }),
      expense({ shiftId: 'other', amount: 4000, status: 'approved' }),
    ];

    const recon = reconcileShift(s, tickets, expenses);
    expect(recon.totalCashTickets).toBe(1500);
    expect(recon.totalApprovedExpenses).toBe(200);
    expect(recon.expectedCash).toBe(1300);
  });

  it('excludes voided tickets from a shift’s expected cash', () => {
    const s = shift({ id: 's1' });
    const recon = reconcileShift(
      s,
      [
        ticket({ cashierId: 'c1', amount: 1000, createdAt: new Date(2026, 7, 30, 9).toISOString() }),
        ticket({ cashierId: 'c1', amount: 600, status: 'void', createdAt: new Date(2026, 7, 30, 9).toISOString() }),
      ],
      []
    );
    expect(recon.expectedCash).toBe(1000);
  });

  it('reports what a closed shift recorded, not a recomputation of it', () => {
    // A ticket voided after close-out must not silently rewrite the variance the cashier
    // was actually held to.
    const closed = shift({
      status: 'closed',
      closedAt: new Date(2026, 7, 30, 16).toISOString(),
      expectedCash: 1500,
      countedCash: 1450,
      variance: -50,
    });
    const recon = reconcileShift(closed, [], []);
    expect(recon.expectedCash).toBe(1500);
    expect(recon.countedCash).toBe(1450);
    expect(recon.variance).toBe(-50);
    expect(recon.isVarianceFlagged).toBe(true);
  });

  it('does not flag a closed shift that balanced', () => {
    const closed = shift({
      status: 'closed',
      closedAt: new Date(2026, 7, 30, 16).toISOString(),
      expectedCash: 1500,
      countedCash: 1500,
      variance: 0,
    });
    expect(reconcileShift(closed, [], []).isVarianceFlagged).toBe(false);
  });
});

describe('shiftExpenses', () => {
  it('takes only expenses charged to that shift', () => {
    const rows = shiftExpenses(
      [expense({ shiftId: 's1' }), expense({ shiftId: 's2' })],
      { id: 's1' }
    );
    expect(rows).toHaveLength(1);
  });
});
