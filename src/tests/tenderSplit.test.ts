import { describe, it, expect, beforeEach } from 'vitest';
import { splitByTender, isCashTicket, reconcileShift, bucketBreakdown } from '../utils/analytics';
import { periodFor, periodBuckets } from '../utils/period';
import { Ticket } from '../types/ticket';
import { Shift } from '../types/shift';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { useTicketStore } from '../store/useTicketStore';

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

function openShift(over: Partial<Shift> = {}): Shift {
  return {
    id: 'S-1',
    locationId: 'LOC01',
    deviceId: 'DEV01',
    cashierId: 'c1',
    cashierName: 'Ada',
    status: 'open',
    openedAt: '2026-08-30T08:00:00.000Z',
    openingFloat: 0,
    ...over,
  };
}

describe('Cash / Transfer tender split', () => {
  it('reads a ticket with no tender recorded as cash', () => {
    // Every ticket issued before the split existed was a drawer sale. If these ever stop
    // counting as cash, historic shifts start reporting shortages that never happened.
    expect(isCashTicket(ticket())).toBe(true);
    expect(isCashTicket(ticket({ tender: 'cash' }))).toBe(true);
    expect(isCashTicket(ticket({ tender: 'transfer' }))).toBe(false);
  });

  it('splits revenue into drawer cash and transfer/POS', () => {
    const split = splitByTender([
      ticket({ amount: 5000, tender: 'cash' }),
      ticket({ amount: 2000 }), // legacy row, no tender — cash
      ticket({ amount: 3000, tender: 'transfer' }),
    ]);

    expect(split.total).toBe(10000);
    expect(split.cash).toBe(7000);
    expect(split.transfer).toBe(3000);
  });

  it('excludes voided tickets from every bucket', () => {
    const split = splitByTender([
      ticket({ amount: 5000, tender: 'cash' }),
      ticket({ amount: 4000, tender: 'cash', status: 'void' }),
      ticket({ amount: 3000, tender: 'transfer', status: 'void' }),
    ]);

    expect(split.total).toBe(5000);
    expect(split.cash).toBe(5000);
    expect(split.transfer).toBe(0);
  });

  it('always reconciles: cash + transfer equals total', () => {
    const tickets = [
      ticket({ amount: 1500, tender: 'cash' }),
      ticket({ amount: 250, tender: 'transfer' }),
      ticket({ amount: 75 }),
    ];
    const split = splitByTender(tickets);
    expect(split.cash + split.transfer).toBe(split.total);
  });
});

describe('Shift reconciliation excludes non-cash sales from the drawer', () => {
  it('expects only cash sales in the drawer, not transfer/POS sales', () => {
    // This is the bug the split exists to fix: a shift that took ₦4,000 by transfer used
    // to expect that money in the drawer and flag the cashier ₦4,000 short.
    const shift = openShift();
    const tickets = [
      ticket({ amount: 6000, tender: 'cash' }),
      ticket({ amount: 4000, tender: 'transfer' }),
    ];

    const recon = reconcileShift({ ...shift, countedCash: 6000 }, tickets, []);

    expect(recon.totalCashTickets).toBe(6000);
    expect(recon.expectedCash).toBe(6000);
    expect(recon.variance).toBe(0);
    expect(recon.isVarianceFlagged).toBe(false);
  });

  it('charges approved expenses against cash, never against transfer takings', () => {
    const shift = openShift();
    const tickets = [
      ticket({ amount: 6000, tender: 'cash' }),
      ticket({ amount: 4000, tender: 'transfer' }),
    ];
    const expenses = [
      {
        id: 'E-1',
        shiftId: 'S-1',
        cashierId: 'c1',
        amount: 1000,
        category: 'gas',
        description: 'gas',
        status: 'approved' as const,
        loggedAt: '2026-08-30T10:00:00.000Z',
      },
    ];

    const recon = reconcileShift({ ...shift, countedCash: 5000 }, tickets, expenses as any);

    // 6000 cash − 1000 spent = 5000 in the drawer. The 4000 transfer never enters it.
    expect(recon.expectedCash).toBe(5000);
    expect(recon.variance).toBe(0);
  });

  it('still balances a legacy all-cash shift with no tender recorded anywhere', () => {
    const shift = openShift();
    const tickets = [ticket({ amount: 3000 }), ticket({ amount: 2000 })];

    const recon = reconcileShift({ ...shift, countedCash: 5000 }, tickets, []);

    expect(recon.expectedCash).toBe(5000);
    expect(recon.isVarianceFlagged).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Correcting a mis-tagged ticket
// ─────────────────────────────────────────────────────────────────────────────

describe('Retagging a mis-tagged payment type', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
  });

  async function saveTicket(over: Partial<Ticket> = {}) {
    const t = ticket({ id: 'LOC01-DEV01-000001', ...over });
    await svc.saveTicket(t);
    return t;
  }

  it('moves a ticket from cash to transfer and audit-logs the change', async () => {
    await saveTicket({ tender: 'cash' });
    await svc.updateTicketTender('LOC01-DEV01-000001', 'transfer', 'u-1');

    const [stored] = await svc.getTickets();
    expect(stored.tender).toBe('transfer');

    // Never a silent edit: this moves money between the drawer figure and the transfer
    // figure, so a manager has to be able to see who did it.
    const logs = await svc.getAuditLogs('LOC01-DEV01-000001');
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('TENDER_CHANGE');
    expect(logs[0].actorId).toBe('u-1');
    expect(logs[0].reason).toBe('cash → transfer');
  });

  it('treats an untagged legacy ticket as coming from cash', async () => {
    await saveTicket({});
    await svc.updateTicketTender('LOC01-DEV01-000001', 'transfer', 'u-1');

    const logs = await svc.getAuditLogs('LOC01-DEV01-000001');
    expect(logs[0].reason).toBe('cash → transfer');
  });

  it('does nothing when the tender is already what was asked for', async () => {
    await saveTicket({ tender: 'transfer' });
    await svc.updateTicketTender('LOC01-DEV01-000001', 'transfer', 'u-1');

    expect(await svc.getAuditLogs('LOC01-DEV01-000001')).toHaveLength(0);
  });

  it('queues the correction for the cloud (AGENTS.md rule 3)', async () => {
    await saveTicket({ tender: 'cash' });
    const before = (await svc.getPendingOutbox()).length;

    await svc.updateTicketTender('LOC01-DEV01-000001', 'transfer', 'u-1');

    const queued = await svc.getPendingOutbox();
    expect(queued.length).toBe(before + 2); // the ticket update, and the audit entry
    const ticketRow = queued.find((r) => r.tableName === 'tickets' && r.action === 'UPDATE');
    expect((ticketRow?.payload as any).tender).toBe('transfer');
  });

  it('a retagged ticket immediately reconciles against the drawer differently', async () => {
    // The whole point of the correction path: fixing the tag has to fix the cash figure,
    // not just the label on the card.
    const t = ticket({ amount: 4000, tender: 'transfer' });
    expect(splitByTender([t]).cash).toBe(0);
    expect(splitByTender([{ ...t, tender: 'cash' }]).cash).toBe(4000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What the manager console reports
// ─────────────────────────────────────────────────────────────────────────────

describe('Period reporting carries the split', () => {
  const week = periodFor('week', new Date(2026, 7, 26));
  const buckets = periodBuckets(week);

  it('splits each day into cash and transfer, and both still sum to revenue', () => {
    const rows = bucketBreakdown(
      [
        ticket({ amount: 5000, tender: 'cash', createdAt: new Date(2026, 7, 26, 10).toISOString() }),
        ticket({ amount: 3000, tender: 'transfer', createdAt: new Date(2026, 7, 26, 11).toISOString() }),
        ticket({ amount: 1000, createdAt: new Date(2026, 7, 27, 9).toISOString() }), // legacy → cash
      ],
      [],
      buckets
    );

    const wed = rows.find((r) => r.revenue === 8000)!;
    expect(wed.cash).toBe(5000);
    expect(wed.transfer).toBe(3000);

    const thu = rows.find((r) => r.revenue === 1000)!;
    expect(thu.cash).toBe(1000);
    expect(thu.transfer).toBe(0);

    // The figure an owner banks against: no naira may go missing between the columns.
    for (const r of rows) expect(r.cash + r.transfer).toBe(r.revenue);
  });

  it('keeps voided tickets out of both columns', () => {
    const rows = bucketBreakdown(
      [
        ticket({ amount: 5000, tender: 'transfer', status: 'void', createdAt: new Date(2026, 7, 26, 10).toISOString() }),
      ],
      [],
      buckets
    );

    expect(rows.every((r) => r.revenue === 0 && r.cash === 0 && r.transfer === 0)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The till header's own two figures
// ─────────────────────────────────────────────────────────────────────────────

describe("Today's counters on the till header", () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    useTicketStore.setState({ tickets: [], ticketsTodayCount: 0, ticketsTodayTotal: 0, scope: undefined });
  });

  it('totals today’s takings and leaves voids out of both figures', async () => {
    const svc = new IndexedDbService();
    await svc.init();
    const now = new Date();
    const iso = (h: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h).toISOString();

    await svc.saveTicket(ticket({ id: 'A', amount: 2500, createdAt: iso(9) }));
    await svc.saveTicket(ticket({ id: 'B', amount: 1500, tender: 'transfer', createdAt: iso(10) }));
    await svc.saveTicket(ticket({ id: 'C', amount: 9999, status: 'void', createdAt: iso(11) }));

    await useTicketStore.getState().loadTickets();

    // Transfers count towards the day's takings — this figure is the whole shift's
    // trade, not the drawer. The drawer number is close-out's job.
    expect(useTicketStore.getState().ticketsTodayCount).toBe(2);
    expect(useTicketStore.getState().ticketsTodayTotal).toBe(4000);
  });

  it('uses the local midnight, not the UTC one', async () => {
    const svc = new IndexedDbService();
    await svc.init();
    const now = new Date();

    // 00:30 local. Under the old UTC-prefix comparison this landed on yesterday's date
    // anywhere east of Greenwich, so a restaurant trading past midnight watched the first
    // hour of its night go missing from the header.
    const justAfterLocalMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30);
    await svc.saveTicket(ticket({ id: 'A', amount: 3000, createdAt: justAfterLocalMidnight.toISOString() }));

    await useTicketStore.getState().loadTickets();

    expect(useTicketStore.getState().ticketsTodayCount).toBe(1);
    expect(useTicketStore.getState().ticketsTodayTotal).toBe(3000);
  });
});
